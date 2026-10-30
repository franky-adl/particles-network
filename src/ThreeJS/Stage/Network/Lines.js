import * as THREE from "three";
import Orchestrator from "../../Orchestrator.js";
import SpatialGrid from "../../Utils/SpatialGrid.js";
import vertexShader from "../shaders/lines/vertex.glsl";
import fragmentShader from "../shaders/lines/fragment.glsl";

// Floats stored per line segment in the instance buffer:
// start.xyz, end.xyz, closeness, rankFade
const STRIDE = 8;

// GUI max for maxConnections. The neighbour table keeps one extra slot past
// this (the next-closest challenger) so the last allowed line can crossfade
// with the one about to replace it, instead of popping.
const MAX_CONNECTIONS = 8;
const NEIGHBOR_STRIDE = MAX_CONNECTIONS + 1;

// Packs a pair (i < j) into one int for the opacity table. Both indices
// stay below 65536 (the particle count slider tops out far under that).
const PAIR_KEY_STRIDE = 65536;
// Empty slot in the open-addressed pair table.
const PAIR_EMPTY = -1;
// A dropped line decays to about this fraction after `fadeTime` seconds.
const FADE_SETTLE = 0.05;

// Width of that crossfade, as a fraction of connectDistance. While the
// challenger is farther than this, the last slot is solid and the challenger
// is hidden; as the two distances meet they share the slot's opacity.
const RANK_FADE_WIDTH = 0.25;

/** Hermite smoothstep. Returns 0 at edge0 and 1 at edge1. */
function smoothstep(edge0, edge1, x) {
    const span = edge1 - edge0;
    if (span <= 1e-8) return x >= edge1 ? 1 : 0;
    const t = Math.min(1, Math.max(0, (x - edge0) / span));
    return t * t * (3 - 2 * t);
}

/**
 * Lines
 * -----
 * Draws a thin line between pairs of particles that are close enough,
 * capped so each particle keeps at most its closest `maxConnections`
 * neighbours (and only when that link is mutual), and fades each line
 * in/out smoothly with the distance between its two ends.
 *
 * How it works, per frame (update()):
 *   1. Network gives us the current particle positions.
 *   2. A SpatialGrid (../../Utils/SpatialGrid.js) finds every pair of
 *      particles closer than `connectDistance`.
 *   3. Each close pair is inserted into a fixed-size list on BOTH endpoints
 *      (the grid reports each pair once). The list holds the closest
 *      `maxConnections` neighbours plus one extra challenger (the next
 *      closest still inside connectDistance). A full list rejects anyone
 *      farther than its current farthest entry in one compare.
 *   4. After the walk, each mutual link gets a target opacity from the cap:
 *      1 when it is closer than the last allowed slot, a crossfade between
 *      that slot and the challenger, and 0 once it has lost the cap. The
 *      opacity that is drawn eases toward that target over `fadeTime`, so a
 *      line that wins or loses the cap fades in or out instead of popping.
 *      A link that drops out of the lists is kept until the eased opacity
 *      has fallen away. The fragment shader multiplies that opacity into
 *      the distance fade, and mixes color near / color far from closeness
 *      alone.
 *   5. Segments are written into one buffer and drawn in a single instanced
 *      draw call. Only as many instances as there are segments are drawn.
 *
 * Why a custom quad instead of THREE.LineSegments? WebGL can only draw
 * 1-pixel-wide lines, so there'd be no thickness control. Instead each segment
 * is a flat rectangle ("quad") that the vertex shader
 * (shaders/lines/vertex.glsl) stretches between the two end points and widens
 * to a width in pixels. The fragment shader anti-aliases its edges.
 *
 * Performance note: comparing every particle with every other would cost
 * O(count²) per frame. The SpatialGrid instead only compares particles in
 * neighbouring grid cells (each cell is `connectDistance` wide), which is
 * roughly O(count) when particles are spread out. A large connectDistance
 * makes cells big and the search slower again, because more particles share a
 * cell and every one of them has to be tested. The top-K filter does not
 * shrink that search (every in-range pair must be seen to know which are
 * closest); it bounds how many segments are uploaded and drawn. The table
 * keeps one extra neighbour per particle so the cap has a challenger to
 * score against. Drawn opacity eases toward that score in a reused table of
 * recent edges, which costs O(active edges) per frame.
 *
 * Tweakable params (shown in the "lines" GUI folder), all live:
 *   color near       Tint of the shortest lines (particles almost touching).
 *   color far        Tint of the longest lines (length = connectDistance).
 *                    A line's colour is a straight mix of the two from its
 *                    length, so a line halfway to connectDistance is halfway
 *                    between the two colours.
 *   thickness        Line width in CSS pixels (uniform). Below 1px the line
 *                    stays 1px wide but is dimmed, which looks thinner than
 *                    actually shrinking it would (that would alias/shimmer).
 *   opacity          Overall line transparency; multiplies the per-line
 *                    fade (uniform).
 *   connectDistance  Max distance (world units) at which two particles may
 *                    be considered for a link (this.params). Larger widens
 *                    the search and the fade span (0 -> connectDistance);
 *                    the degree cap still limits how many lines each particle
 *                    keeps.
 *   maxConnections   Max closest neighbours kept per particle. A line's target
 *                    opacity is full only when both ends list each other
 *                    inside that cap. The last slot and the next-closest
 *                    challenger share a lower target; fadeTime eases the
 *                    drawn line toward it.
 *   fadeTime         Seconds for that drawn opacity to settle. A line that
 *                    loses the cap falls to about 5% across this many seconds,
 *                    and a line that gains one rises the same way. Length
 *                    still drives its own fade, from 1 at a touch to 0 at
 *                    connectDistance.
 *
 * Depth of field: lines out of focus blur themselves. The vertex shader
 * computes a circle of confusion at each end (from its depth), widens the
 * quad by it, and extends past each endpoint into a capsule so the butts
 * become round caps matching the particle discs. The fragment shader shades
 * soft distance to the segment and dims with the energy term. A line can
 * therefore be sharp at one end and blurred at the other. The controls live
 * in Network's "depth of field" GUI folder because Particles shares the
 * same uniforms.
 */
export default class Lines {
    /**
     * @param {THREE.Object3D} parent Where to attach the mesh (Network's group).
     * @param {object} dofUniforms Depth-of-field uniforms shared with Particles
     *        (created and exposed in the GUI by Network).
     */
    constructor(parent, dofUniforms) {
        this.orc = new Orchestrator();
        this.sizes = this.orc.sizes;
        this.debug = this.orc.debug;
        this.parent = parent;
        this.dofUniforms = dofUniforms;

        this.params = {
            connectDistance: 1.5,
            maxConnections: 5,
            // Seconds for cap-opacity to fall from 1 to about FADE_SETTLE.
            fadeTime: 1,
        };

        // Finds the close pairs each frame (see update()).
        this.grid = new SpatialGrid();
        // State shared with onPair() / addSegment() for the update() pass.
        this.segments = 0;
        this.positions = null;
        this.maxDistance = 0;
        this.maxConnections = 0;
        this.particleCount = 0;
        // Created once (not inside update()) so no new closure is allocated every frame.
        this.onPair = (i, j, distanceSq) => this.considerPair(i, j, distanceSq);

        // Top-K neighbour tables (grown in ensureNeighborCapacity()).
        // neighborOf / neighborDistSq are laid out as particle * NEIGHBOR_STRIDE + slot.
        this.neighborCapacity = 0;
        this.neighborOf = new Int32Array(0);
        this.neighborDistSq = new Float32Array(0);
        this.neighborCount = new Uint8Array(0);
        // Farthest kept distanceSq per particle; Infinity until the list is full
        // (full means maxConnections + 1, including the challenger).
        this.kthDistSq = new Float32Array(0);
        // DistanceSq of the last allowed neighbour, and the smoothstep (0..1)
        // of how far the challenger sits beyond it. keepDistSq stays Infinity
        // when the particle has no challenger, so every link is fully opaque.
        this.keepDistSq = new Float32Array(0);
        this.rankFadeT = new Float32Array(0);
        this.scratchDist = new Float32Array(NEIGHBOR_STRIDE);
        this.rankFadeWidth = 0;

        // Recent edges and the opacity actually drawn for each (see easeEdges).
        // Grown when a frame needs more room; nothing here is allocated per frame.
        this.edgeCount = 0;
        this.edgeCapacity = 0;
        this.edgeI = new Int32Array(0);
        this.edgeJ = new Int32Array(0);
        this.edgeOpacity = new Float32Array(0);
        this.edgeStamp = new Uint32Array(0);
        this.hashCapacity = 0;
        this.hashMask = 0;
        this.hashKey = new Int32Array(0);
        this.hashIndex = new Int32Array(0);
        this.fadeFrame = 0;
        this.allocateFadeEdges(1024);

        // Start with room for 2048 segments; update() grows to fit eased edges.
        this.setGeometry(2048);
        this.setMaterial();
        this.setMesh();
        this.setDebug();
    }

    /**
     * Grows the per-particle top-K tables if `count` exceeds the current capacity.
     * Uses 50% headroom so small count increases do not reallocate every time.
     *
     * @param {number} count Number of particles this frame.
     */
    ensureNeighborCapacity(count) {
        if (count <= this.neighborCapacity) return;
        const capacity = Math.ceil(count * 1.5);
        this.neighborCapacity = capacity;
        this.neighborOf = new Int32Array(capacity * NEIGHBOR_STRIDE);
        this.neighborDistSq = new Float32Array(capacity * NEIGHBOR_STRIDE);
        this.neighborCount = new Uint8Array(capacity);
        this.kthDistSq = new Float32Array(capacity);
        this.keepDistSq = new Float32Array(capacity);
        this.rankFadeT = new Float32Array(capacity);
    }

    /**
     * Builds the geometry: one shared quad, plus a per-segment instance buffer.
     * Each line segment is an instanced quad, expanded to a pixel width in the
     * vertex shader (WebGL's native lines are always 1px wide).
     *
     * @param {number} capacity Max number of segments the buffer can hold.
     *        Called again with a larger value if more segments are needed.
     *
     * Two kinds of data:
     *   - Per-vertex (the 4 corners of the quad, identical for every segment):
     *       position.x = 0 or 1  -> which end of the segment this corner is on
     *       position.y = -1 or 1 -> which side of the line (used to widen it)
     *   - Per-instance (one entry per segment, read via the interleaved buffer):
     *       instanceStart      xyz of one end
     *       instanceEnd        xyz of the other end
     *       instanceCloseness  1 when the ends touch, 0 at connectDistance.
     *                          The fragment shader fades with a smoothstep of this
     *                          and mixes color near / color far with it directly.
     *       instanceRankFade  1 for links inside the cap. The last allowed slot
     *                          and its challenger share this across the crossfade
     *                          (0 hides a line that has lost the cap). Multiplies
     *                          opacity only; it does not shift the colour.
     *     "Interleaved" means all 8 floats for a segment sit together in memory
     *     (see STRIDE), which makes the per-frame upload a single contiguous range.
     */
    setGeometry(capacity) {
        // Free the old buffers if we're growing.
        this.geometry?.dispose();
        this.capacity = capacity;

        this.geometry = new THREE.InstancedBufferGeometry();
        // The 4 quad corners, as (x, y, z) triples.
        this.geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
                [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0],
                3,
            ),
        );
        // Two triangles making up the quad.
        this.geometry.setIndex([0, 1, 2, 0, 2, 3]);

        // CPU-side array we fill in update(); `buffer` uploads it to the GPU.
        this.data = new Float32Array(capacity * STRIDE);
        this.buffer = new THREE.InstancedInterleavedBuffer(
            this.data,
            STRIDE,
        ).setUsage(THREE.DynamicDrawUsage);
        // The three attributes are views onto different slices of each 7-float
        // record: (buffer, size, offset).
        this.geometry.setAttribute(
            "instanceStart",
            new THREE.InterleavedBufferAttribute(this.buffer, 3, 0),
        );
        this.geometry.setAttribute(
            "instanceEnd",
            new THREE.InterleavedBufferAttribute(this.buffer, 3, 3),
        );
        this.geometry.setAttribute(
            "instanceCloseness",
            new THREE.InterleavedBufferAttribute(this.buffer, 1, 6),
        );
        this.geometry.setAttribute(
            "instanceRankFade",
            new THREE.InterleavedBufferAttribute(this.buffer, 1, 7),
        );
        // Draw nothing until update() has counted the segments.
        this.geometry.instanceCount = 0;

        // When growing, point the existing mesh at the new geometry.
        if (this.mesh) this.mesh.geometry = this.geometry;
    }

    /**
     * Creates the shader material. The uniforms are the tweakable params
     * (edited directly by the GUI); uPixelRatio / uResolution are filled in by resize().
     */
    setMaterial() {
        this.material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                uColorNear: { value: new THREE.Color("#4b99ec") },
                uColorFar: { value: new THREE.Color("#0629b7") },
                uOpacity: { value: 0.7 },
                uWidth: { value: 1.5 }, // thickness, CSS pixels
                uPixelRatio: { value: 1 },
                uResolution: { value: new THREE.Vector2() }, // drawing buffer size, px
                // Depth-of-field blur params, shared with Particles (see Network).
                ...this.dofUniforms,
            },
            // Partially transparent, light-like look: additive blending lets
            // overlapping lines brighten where the web is dense.
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        this.resize();
    }

    /** Creates the mesh and adds it to the parent group. */
    setMesh() {
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        // Bounds come from the unit quad, not the segments.
        // Three.js would compute a tiny bounding box from the 4 quad corners
        // and wrongly cull the lines, so culling is turned off.
        this.mesh.frustumCulled = false;
        this.parent.add(this.mesh);
    }

    /**
     * Adds this class's controls to the lil-gui "lines" folder.
     * debug.addColor converts between the color picker's sRGB and three.js's
     * linear color space.
     */
    setDebug() {
        if (this.debug.active) {
            this.debugFolder = this.debug.ui.addFolder("lines");
            const uniforms = this.material.uniforms;

            this.debug
                .addColor(
                    this.debugFolder,
                    uniforms.uColorNear.value,
                    "colorNear",
                )
                .name("color near");
            this.debug
                .addColor(
                    this.debugFolder,
                    uniforms.uColorFar.value,
                    "colorFar",
                )
                .name("color far");
            this.debugFolder
                .add(uniforms.uWidth, "value")
                .name("thickness")
                .min(0.1)
                .max(6)
                .step(0.01);
            this.debugFolder
                .add(uniforms.uOpacity, "value")
                .name("opacity")
                .min(0)
                .max(1)
                .step(0.001);
            // Plain JS params (not uniforms): read in update() on the next frame.
            this.debugFolder
                .add(this.params, "connectDistance")
                .min(0.05)
                .max(2)
                .step(0.001);
            this.debugFolder
                .add(this.params, "maxConnections")
                .min(1)
                .max(MAX_CONNECTIONS)
                .step(1);
            this.debugFolder
                .add(this.params, "fadeTime")
                .name("fade time")
                .min(0.05)
                .max(4)
                .step(0.01);
        }
    }

    /**
     * Called on window resize. The vertex shader works in screen pixels to give
     * lines a constant pixel width, so it needs the drawing-buffer size and
     * the pixel ratio (to turn CSS pixels into device pixels on retina screens).
     */
    resize() {
        const { width, height, pixelRatio } = this.sizes;
        this.material.uniforms.uPixelRatio.value = pixelRatio;
        this.material.uniforms.uResolution.value.set(
            width * pixelRatio,
            height * pixelRatio,
        );
    }

    /**
     * Called every frame by Network. Finds close pairs, keeps each particle's
     * closest `maxConnections` neighbours, and fills the instance buffer.
     * Drawn opacity eases toward the cap target, so lines that just lost the
     * cap stay in the buffer until they have faded out.
     *
     * @param {Float32Array} positions Current xyz of every particle.
     * @param {number} count Number of particles in `positions`.
     * @param {number} delta Seconds since the previous frame. Drives the
     *        cap-opacity ease (see fadeTime).
     */
    update(positions, count, delta) {
        const maxDistance = this.params.connectDistance;
        // Clamp to the reserved stride so a hand-edited value cannot overrun the tables.
        const maxConnections = Math.min(
            MAX_CONNECTIONS,
            Math.max(1, this.params.maxConnections | 0),
        );

        this.positions = positions;
        this.maxDistance = maxDistance;
        this.maxConnections = maxConnections;
        this.rankFadeWidth = maxDistance * RANK_FADE_WIDTH;
        this.particleCount = count;
        this.segments = 0;

        this.ensureNeighborCapacity(count);
        // Only the counts and farthest-distance caches need clearing; slot data
        // for unused indices is overwritten on the next insert.
        this.neighborCount.fill(0, 0, count);
        this.kthDistSq.fill(Infinity, 0, count);

        // Sort the particles into grid cells, then collect each close pair into
        // both endpoints' top-K lists via considerPair().
        this.grid.build(positions, count, maxDistance);
        this.grid.forEachPair(positions, maxDistance, this.onPair);

        this.prepareRankBounds();
        this.easeEdges(delta);

        // Fading-out lines are still drawn, so the buffer has to hold every
        // edge still in the opacity table, not only this frame's mutual pairs.
        if (this.edgeCount > this.capacity) {
            this.setGeometry(Math.ceil(this.edgeCount * 1.5));
        }
        this.emitFadedSegments();

        // Draw only the segments we filled, and upload only that part of the buffer.
        this.geometry.instanceCount = this.segments;
        this.buffer.clearUpdateRanges();
        this.buffer.addUpdateRange(0, this.segments * STRIDE);
        this.buffer.needsUpdate = true;
    }

    /**
     * Receives one close pair from the SpatialGrid and tries to insert it into
     * both endpoints' neighbour lists (closest `maxConnections` plus one
     * challenger). Called (via this.onPair) once per pair closer than
     * connectDistance; writing both sides is required because the grid
     * reports each pair only once.
     *
     * @param {number} i Index of the first particle.
     * @param {number} j Index of the second particle.
     * @param {number} distanceSq Squared distance between them.
     */
    considerPair(i, j, distanceSq) {
        this.insertNeighbor(i, j, distanceSq);
        this.insertNeighbor(j, i, distanceSq);
    }

    /**
     * Keeps `partner` in particle `i`'s list if it is closer than the current
     * farthest kept neighbour (or if the list still has a free slot). The list
     * holds maxConnections + 1 entries so the challenger past the cap is kept
     * for the opacity crossfade.
     *
     * @param {number} i Particle whose list is being updated.
     * @param {number} partner Candidate neighbour index.
     * @param {number} distanceSq Squared distance from i to partner.
     */
    insertNeighbor(i, partner, distanceSq) {
        // Hot path once the list is full: one compare rejects anyone too far.
        if (distanceSq >= this.kthDistSq[i]) return;

        const limit = this.maxConnections + 1;
        const base = i * NEIGHBOR_STRIDE;
        const count = this.neighborCount[i];
        const { neighborOf, neighborDistSq } = this;

        if (count < limit) {
            const slot = base + count;
            neighborOf[slot] = partner;
            neighborDistSq[slot] = distanceSq;
            this.neighborCount[i] = count + 1;
            if (count + 1 === limit) {
                this.refreshKthDistSq(i);
            }
            return;
        }

        // Replace the farthest kept neighbour, then rescan to refresh the cache.
        let farthestSlot = base;
        let farthestDist = neighborDistSq[base];
        for (let s = 1; s < limit; s++) {
            const dist = neighborDistSq[base + s];
            if (dist > farthestDist) {
                farthestDist = dist;
                farthestSlot = base + s;
            }
        }
        neighborOf[farthestSlot] = partner;
        neighborDistSq[farthestSlot] = distanceSq;
        this.refreshKthDistSq(i);
    }

    /**
     * Sets kthDistSq[i] to the farthest distanceSq currently stored for particle i.
     * Only called when the list is (or stays) full, so the hot-path reject works.
     *
     * @param {number} i Particle index.
     */
    refreshKthDistSq(i) {
        const base = i * NEIGHBOR_STRIDE;
        const n = this.neighborCount[i];
        const { neighborDistSq } = this;
        let farthest = neighborDistSq[base];
        for (let s = 1; s < n; s++) {
            const dist = neighborDistSq[base + s];
            if (dist > farthest) farthest = dist;
        }
        this.kthDistSq[i] = farthest;
    }

    /**
     * For each particle that has a challenger past the cap, records the
     * distanceSq of the last allowed neighbour and how resolved the crossfade
     * is (0 when the challenger is tied with that slot, 1 when it is far
     * enough past RANK_FADE_WIDTH to be hidden).
     */
    prepareRankBounds() {
        const count = this.particleCount;
        const maxConnections = this.maxConnections;
        const fadeWidth = this.rankFadeWidth;
        const {
            neighborCount,
            neighborDistSq,
            keepDistSq,
            rankFadeT,
            scratchDist,
        } = this;

        for (let i = 0; i < count; i++) {
            const n = neighborCount[i];
            if (n <= maxConnections) {
                keepDistSq[i] = Infinity;
                continue;
            }

            const base = i * NEIGHBOR_STRIDE;
            for (let s = 0; s < n; s++) scratchDist[s] = neighborDistSq[base + s];
            for (let s = 1; s < n; s++) {
                const value = scratchDist[s];
                let p = s;
                while (p > 0 && scratchDist[p - 1] > value) {
                    scratchDist[p] = scratchDist[p - 1];
                    p--;
                }
                scratchDist[p] = value;
            }

            const keep = scratchDist[maxConnections - 1];
            const next = scratchDist[maxConnections];
            keepDistSq[i] = keep;
            rankFadeT[i] = smoothstep(0, fadeWidth, Math.sqrt(next) - Math.sqrt(keep));
        }
    }

    /**
     * Opacity share (0..1) of one endpoint for a link at `distanceSq`.
     * Links closer than the last allowed slot return 1. That slot and the
     * challenger split the remainder from the crossfade prepared above.
     *
     * @param {number} i Particle index.
     * @param {number} distanceSq Squared distance of the link.
     */
    rankWeight(i, distanceSq) {
        const keep = this.keepDistSq[i];
        if (distanceSq < keep) return 1;
        const t = this.rankFadeT[i];
        // t is 1 when the last slot is clearly ahead of the challenger, and 0
        // when the two distances are tied. The slot holder fades 1 → 0.5 as
        // the challenger catches up; after the swap that same link is the
        // challenger and fades 0.5 → 0 as the new slot pulls away.
        if (distanceSq <= keep) return 0.5 + 0.5 * t;
        return 0.5 * (1 - t);
    }

    /**
     * Drops every remembered pair. Called when the layout is regenerated,
     * because particle indices no longer refer to the same points.
     */
    clearFadeEdges() {
        this.edgeCount = 0;
        if (this.hashKey.length) this.hashKey.fill(PAIR_EMPTY);
    }

    /**
     * Allocates (or grows) the edge list and its hash table. Existing edges
     * are copied across; the hash is rebuilt from them.
     *
     * @param {number} minEdges Minimum edge slots required.
     */
    allocateFadeEdges(minEdges) {
        const capacity = Math.max(1024, Math.ceil(minEdges * 1.5));
        if (capacity <= this.edgeCapacity && this.hashCapacity > 0) return;

        const edgeI = new Int32Array(capacity);
        const edgeJ = new Int32Array(capacity);
        const edgeOpacity = new Float32Array(capacity);
        const edgeStamp = new Uint32Array(capacity);
        edgeI.set(this.edgeI.subarray(0, this.edgeCount));
        edgeJ.set(this.edgeJ.subarray(0, this.edgeCount));
        edgeOpacity.set(this.edgeOpacity.subarray(0, this.edgeCount));
        edgeStamp.set(this.edgeStamp.subarray(0, this.edgeCount));
        this.edgeI = edgeI;
        this.edgeJ = edgeJ;
        this.edgeOpacity = edgeOpacity;
        this.edgeStamp = edgeStamp;
        this.edgeCapacity = capacity;

        let hashCapacity = this.hashCapacity || 16;
        const minHash = capacity * 2;
        while (hashCapacity < minHash) hashCapacity *= 2;
        this.hashCapacity = hashCapacity;
        this.hashMask = hashCapacity - 1;
        this.hashKey = new Int32Array(hashCapacity);
        this.hashKey.fill(PAIR_EMPTY);
        this.hashIndex = new Int32Array(hashCapacity);
        for (let e = 0; e < this.edgeCount; e++) {
            this.insertHash(this.edgeI[e] * PAIR_KEY_STRIDE + this.edgeJ[e], e);
        }
    }

    /** Mixes a packed pair key into a hash-table slot. */
    hashCode(key) {
        let h = key | 0;
        h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
        h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
        return (h ^ (h >>> 16)) >>> 0;
    }

    /**
     * Linear-probe slot for `key`: either the slot that holds it, or the
     * first empty slot a new insert should use.
     *
     * @param {number} key Packed pair.
     */
    findHash(key) {
        const mask = this.hashMask;
        const keys = this.hashKey;
        let slot = this.hashCode(key) & mask;
        while (true) {
            const found = keys[slot];
            if (found === PAIR_EMPTY || found === key) return slot;
            slot = (slot + 1) & mask;
        }
    }

    /**
     * Writes `key` into the table at its probe slot. The key must be absent.
     *
     * @param {number} key Packed pair.
     * @param {number} index Index in the edge arrays.
     */
    insertHash(key, index) {
        const slot = this.findHash(key);
        this.hashKey[slot] = key;
        this.hashIndex[slot] = index;
    }

    /**
     * Removes `key` and repairs the probe chain so later keys stay reachable.
     *
     * @param {number} key Packed pair.
     */
    deleteHash(key) {
        const mask = this.hashMask;
        const keys = this.hashKey;
        const index = this.hashIndex;
        let hole = this.hashCode(key) & mask;
        while (keys[hole] !== key) {
            if (keys[hole] === PAIR_EMPTY) return;
            hole = (hole + 1) & mask;
        }
        keys[hole] = PAIR_EMPTY;
        let next = hole;
        for (;;) {
            next = (next + 1) & mask;
            if (keys[next] === PAIR_EMPTY) return;
            const home = this.hashCode(keys[next]) & mask;
            // The entry can stay when its home slot still lies on the probe
            // path between the hole and this slot. Otherwise it moves into
            // the hole and the hole follows it.
            let canStay;
            if (hole <= next) canStay = home > hole && home <= next;
            else canStay = home > hole || home <= next;
            if (canStay) continue;
            keys[hole] = keys[next];
            index[hole] = index[next];
            keys[next] = PAIR_EMPTY;
            hole = next;
        }
    }

    /**
     * Drops the edge at `index`, swapping the last edge into its place so
     * the live range stays packed.
     *
     * @param {number} index Edge to drop.
     */
    removeEdge(index) {
        const key = this.edgeI[index] * PAIR_KEY_STRIDE + this.edgeJ[index];
        this.deleteHash(key);
        const last = this.edgeCount - 1;
        if (index !== last) {
            this.edgeI[index] = this.edgeI[last];
            this.edgeJ[index] = this.edgeJ[last];
            this.edgeOpacity[index] = this.edgeOpacity[last];
            this.edgeStamp[index] = this.edgeStamp[last];
            const lastKey =
                this.edgeI[index] * PAIR_KEY_STRIDE + this.edgeJ[index];
            this.hashIndex[this.findHash(lastKey)] = index;
        }
        this.edgeCount = last;
    }

    /**
     * Eases one pair's drawn opacity toward `target`. A pair seen for the
     * first time starts at 0, so new lines fade in.
     *
     * @param {number} i Lower particle index.
     * @param {number} j Higher particle index.
     * @param {number} target Cap opacity this frame (0..1).
     * @param {number} blend Frame blend, 0 = hold, 1 = snap to target.
     */
    rememberEdge(i, j, target, blend) {
        if (this.edgeCount + 1 > this.edgeCapacity) {
            this.allocateFadeEdges(this.edgeCount + 1);
        }
        const key = i * PAIR_KEY_STRIDE + j;
        const slot = this.findHash(key);
        let index;
        if (this.hashKey[slot] === key) {
            index = this.hashIndex[slot];
        } else {
            index = this.edgeCount++;
            this.edgeI[index] = i;
            this.edgeJ[index] = j;
            this.edgeOpacity[index] = 0;
            this.hashKey[slot] = key;
            this.hashIndex[slot] = index;
        }
        const opacity = this.edgeOpacity[index];
        this.edgeOpacity[index] = opacity + (target - opacity) * blend;
        this.edgeStamp[index] = this.fadeFrame;
    }

    /**
     * Moves every mutual link's drawn opacity toward this frame's cap target,
     * and decays links that dropped out of the lists toward 0 (dropping the
     * slot once the line is invisible).
     *
     * @param {number} delta Seconds since the previous frame.
     */
    easeEdges(delta) {
        this.fadeFrame = (this.fadeFrame + 1) >>> 0;
        if (this.fadeFrame === 0) {
            // Wrapped the stamp counter. Clear stamps first so every edge
            // that is not re-stamped below decays, instead of matching 0.
            this.edgeStamp.fill(0);
            this.fadeFrame = 1;
        }

        const fadeTime = Math.max(0.05, this.params.fadeTime);
        const dt = delta > 0 ? delta : 0;
        // 1 - exp(-rate * dt), with rate chosen so opacity falls to
        // FADE_SETTLE after fadeTime seconds when the target is 0.
        const blend = 1 - Math.exp((Math.log(FADE_SETTLE) * dt) / fadeTime);

        const count = this.particleCount;
        const { neighborOf, neighborCount, neighborDistSq } = this;
        for (let i = 0; i < count; i++) {
            const n = neighborCount[i];
            const base = i * NEIGHBOR_STRIDE;
            for (let s = 0; s < n; s++) {
                const j = neighborOf[base + s];
                if (i >= j) continue;
                if (!this.hasNeighbor(j, i)) continue;
                const distanceSq = neighborDistSq[base + s];
                const target = Math.min(
                    this.rankWeight(i, distanceSq),
                    this.rankWeight(j, distanceSq),
                );
                // A fully resolved challenger is not a new edge. If it is
                // already fading out, the decay pass below keeps easing it.
                if (target < 0.001) continue;
                this.rememberEdge(i, j, target, blend);
            }
        }

        let index = 0;
        while (index < this.edgeCount) {
            if (this.edgeStamp[index] === this.fadeFrame) {
                index++;
                continue;
            }
            const opacity = this.edgeOpacity[index] * (1 - blend);
            if (opacity < 0.001) {
                this.removeEdge(index);
                continue;
            }
            this.edgeOpacity[index] = opacity;
            index++;
        }
    }

    /**
     * Writes one segment per edge that is still visible. Lines that have
     * drifted past connectDistance are skipped: their distance fade is
     * already 0, and the opacity entry keeps decaying on its own.
     */
    emitFadedSegments() {
        const positions = this.positions;
        const maxDistanceSq = this.maxDistance * this.maxDistance;
        for (let e = 0; e < this.edgeCount; e++) {
            const i = this.edgeI[e];
            const j = this.edgeJ[e];
            const i3 = i * 3;
            const j3 = j * 3;
            const dx = positions[j3] - positions[i3];
            const dy = positions[j3 + 1] - positions[i3 + 1];
            const dz = positions[j3 + 2] - positions[i3 + 2];
            const distanceSq = dx * dx + dy * dy + dz * dz;
            if (distanceSq >= maxDistanceSq) continue;
            this.addSegment(i, j, distanceSq, this.edgeOpacity[e]);
        }
    }

    /**
     * Returns true if particle `i`'s neighbour list currently contains `partner`.
     *
     * @param {number} i Particle whose list is searched.
     * @param {number} partner Index to look for.
     */
    hasNeighbor(i, partner) {
        const base = i * NEIGHBOR_STRIDE;
        const n = this.neighborCount[i];
        const { neighborOf } = this;
        for (let s = 0; s < n; s++) {
            if (neighborOf[base + s] === partner) return true;
        }
        return false;
    }

    /**
     * Writes one line segment into the instance buffer.
     *
     * @param {number} i Index of the first particle.
     * @param {number} j Index of the second particle.
     * @param {number} distanceSq Squared distance between them.
     * @param {number} rankFade Opacity share from the connection cap (0..1).
     */
    addSegment(i, j, distanceSq, rankFade) {
        const positions = this.positions;
        const data = this.data;
        const i3 = i * 3;
        const j3 = j * 3;

        // 1 when the particles touch, 0 at connectDistance (and held at 0 if a
        // fading line has drifted farther). The fragment shader smoothsteps
        // this for the fade and mixes color near / color far from it, so
        // colour tracks length directly.
        const closeness = Math.max(
            0,
            1 - Math.sqrt(distanceSq) / this.maxDistance,
        );
        const o = this.segments * STRIDE;
        // start xyz, end xyz, closeness, rankFade: the 8-float record
        // described in setGeometry().
        data[o] = positions[i3];
        data[o + 1] = positions[i3 + 1];
        data[o + 2] = positions[i3 + 2];
        data[o + 3] = positions[j3];
        data[o + 4] = positions[j3 + 1];
        data[o + 5] = positions[j3 + 2];
        data[o + 6] = closeness;
        data[o + 7] = rankFade;
        this.segments++;
    }
}
