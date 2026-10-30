import * as THREE from "three";
import Orchestrator from "../../Orchestrator.js";
import SpatialGrid from "../../Utils/SpatialGrid.js";
import vertexShader from "../shaders/lines/vertex.glsl";
import fragmentShader from "../shaders/lines/fragment.glsl";

// Floats stored per line segment in the instance buffer:
// start.xyz, end.xyz, alpha
const STRIDE = 7;

/**
 * Lines
 * -----
 * Draws a thin line between every pair of particles that are close enough,
 * and fades each line in/out smoothly with the distance between its two ends.
 *
 * How it works, per frame (update()):
 *   1. Network gives us the current particle positions.
 *   2. A SpatialGrid (../../Utils/SpatialGrid.js) finds every pair of
 *      particles closer than `connectDistance`; each becomes a line segment.
 *   3. Each segment gets an alpha from its length: ~0 when the pair is just
 *      barely within range, rising smoothly to 1 as they get closer (a
 *      smoothstep curve). So as particles drift together a line eases into
 *      view, and as they drift apart it eases out, never popping.
 *   4. Segments are written into one buffer and drawn in a single instanced
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
 * cell and every one of them has to be tested.
 *
 * Tweakable params (shown in the "lines" GUI folder), all live:
 *   color            Line tint (uniform).
 *   thickness        Line width in CSS pixels (uniform). Below 1px the line
 *                    stays 1px wide but is dimmed, which looks thinner than
 *                    actually shrinking it would (that would alias/shimmer).
 *   opacity          Overall line transparency; multiplies the per-line
 *                    fade (uniform).
 *   connectDistance  Max distance (world units) at which two particles are
 *                    linked (this.params). Larger = denser, busier web and
 *                    more segments to draw; smaller = sparse, only very
 *                    close pairs connect. It also sets how gradual the
 *                    fade is: the fade spans 0 -> connectDistance.
 *
 * Depth of field: lines out of focus blur themselves. The vertex shader
 * computes a circle of confusion at each end of the quad (from its depth) and
 * widens the quad by it; the fragment shader softens and dims the edge. A line
 * can therefore be sharp at one end and blurred at the other. The controls
 * live in Network's "depth of field" GUI folder because Particles shares the
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
            connectDistance: 1,
        };

        // Finds the close pairs each frame (see update()).
        this.grid = new SpatialGrid();
        // State shared with onPair() for the update() pass in progress.
        this.segments = 0;
        this.positions = null;
        this.maxDistance = 0;
        // Created once (not inside update()) so no new closure is allocated every frame.
        this.onPair = (i, j, distanceSq) => this.addSegment(i, j, distanceSq);

        // Start with room for 2048 segments; it grows automatically if needed (see update()).
        this.setGeometry(2048);
        this.setMaterial();
        this.setMesh();
        this.setDebug();
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
     *       instanceStart  xyz of one end
     *       instanceEnd    xyz of the other end
     *       instanceAlpha  fade amount, 0-1
     *     "Interleaved" means all 7 floats for a segment sit together in memory
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
            "instanceAlpha",
            new THREE.InterleavedBufferAttribute(this.buffer, 1, 6),
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
                uColor: { value: new THREE.Color("#262df2") },
                uOpacity: { value: 0.6 },
                uWidth: { value: 1 }, // thickness, CSS pixels
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

            this.debug.addColor(
                this.debugFolder,
                uniforms.uColor.value,
                "color",
            );
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
            // Plain JS param (not a uniform): read in update() on the next frame.
            this.debugFolder
                .add(this.params, "connectDistance")
                .min(0.05)
                .max(2)
                .step(0.001);
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
     * Called every frame by Network. Finds all close pairs and fills the
     * instance buffer with one segment per pair.
     *
     * @param {Float32Array} positions Current xyz of every particle.
     * @param {number} count Number of particles in `positions`.
     */
    update(positions, count) {
        const maxDistance = this.params.connectDistance;

        // Set up the state that addSegment() reads while the grid reports pairs.
        this.positions = positions;
        this.maxDistance = maxDistance;
        this.segments = 0;

        // Sort the particles into grid cells (cell width = connectDistance),
        // then let the grid report each close pair to addSegment() via onPair.
        this.grid.build(positions, count, maxDistance);
        this.grid.forEachPair(positions, maxDistance, this.onPair);

        // The buffer was too small: reallocate with 50% headroom (so we don't
        // reallocate again next frame) and collect the pairs again. The grid
        // is still valid, so only the pair search is repeated, not build().
        // Rare after warm-up.
        if (this.segments > this.capacity) {
            this.setGeometry(Math.ceil(this.segments * 1.5));
            this.segments = 0;
            this.grid.forEachPair(positions, maxDistance, this.onPair);
        }

        // Draw only the segments we filled, and upload only that part of the buffer.
        this.geometry.instanceCount = this.segments;
        this.buffer.clearUpdateRanges();
        this.buffer.addUpdateRange(0, this.segments * STRIDE);
        this.buffer.needsUpdate = true;
    }

    /**
     * Receives one close pair from the SpatialGrid and writes it into the
     * instance buffer as a line segment. Called (via this.onPair) once per
     * pair closer than connectDistance, in no particular order; order doesn't
     * matter because the lines are blended additively.
     *
     * @param {number} i Index of the first particle.
     * @param {number} j Index of the second particle.
     * @param {number} distanceSq Squared distance between them.
     */
    addSegment(i, j, distanceSq) {
        // Only write while there's room. We keep counting past capacity so
        // update() knows how much bigger the buffer must be.
        if (this.segments < this.capacity) {
            const positions = this.positions;
            const data = this.data;
            const i3 = i * 3;
            const j3 = j * 3;

            // Smoothstep fade so lines ease in as particles approach.
            // t: 0 at maxDistance (just connected) -> 1 at distance 0.
            // t*t*(3 - 2t) is the smoothstep curve: gentle at both ends.
            const t = 1 - Math.sqrt(distanceSq) / this.maxDistance;
            const o = this.segments * STRIDE;
            // start xyz, end xyz, alpha: the 7-float record
            // described in setGeometry().
            data[o] = positions[i3];
            data[o + 1] = positions[i3 + 1];
            data[o + 2] = positions[i3 + 2];
            data[o + 3] = positions[j3];
            data[o + 4] = positions[j3 + 1];
            data[o + 5] = positions[j3 + 2];
            data[o + 6] = t * t * (3 - 2 * t);
        }
        this.segments++;
    }
}
