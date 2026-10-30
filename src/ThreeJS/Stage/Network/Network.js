import * as THREE from "three";
import { SimplexNoise } from "three/addons/math/SimplexNoise.js";
import Orchestrator from "../../Orchestrator.js";
import Particles from "./Particles.js";
import Lines from "./Lines.js";

/**
 * Network
 * -------
 * The top-level "particle network" object. It owns the simulation (where every
 * particle is, and how it moves) and hands the results to two renderers:
 *
 *   Network ─┬─ Particles  draws the glowing dots   (./Particles.js)
 *            └─ Lines      draws the connecting lines (./Lines.js)
 *
 * How it works, per frame:
 *   1. Every particle has a fixed "base position" (chosen once in generate()).
 *   2. update() nudges each particle away from its base position by a smooth
 *      noise offset that slowly changes over time -> subtle organic drift.
 *   3. The resulting positions are passed to Particles (to draw the dots) and
 *      to Lines (which finds pairs that are close and draws a line between them).
 *
 * Both renderers are children of `this.group`, so rotating the group rotates
 * the dots and lines together.
 *
 * Tweakable params (this.params, shown in the "network" GUI folder):
 *
 *   Distribution - these change WHERE particles start, so they only take
 *   effect when you release the slider (onFinishChange) or press "regenerate".
 *   Changing them re-rolls the random layout.
 *     count         Number of particles. More = denser web. Lines finds
 *                   neighbours with a spatial grid (roughly O(count)), so
 *                   thousands are affordable, but the cost still grows with
 *                   count and with Lines' connectDistance.
 *     spreadX/Y/Z   Size of the box (in world units) that particles fill.
 *                   Lower spreadZ for a flatter, more "wallpaper" look.
 *     clustering    How strongly particles gather into filaments/sheets.
 *                   0 = uniform random cloud, higher = tighter, more
 *                   web-like strands with empty gaps in between.
 *     clusterScale  Size of those structures. Small = a few big, broad
 *                   shapes; large = many small, fine-grained strands.
 *
 *   Motion - these are read every frame, so they update live.
 *     speed         How fast the noise field evolves (0 freezes motion).
 *                   Time is accumulated, so changing it never makes
 *                   particles jump.
 *     amplitude     How far (world units) a particle can drift from its
 *                   base position. Keep it small relative to Lines'
 *                   connectDistance so links form/break gently.
 *     noiseScale    How "wavy" the motion field is in space. Low = nearby
 *                   particles move together (large smooth swells); high =
 *                   neighbours move independently (jittery).
 *     rotationSpeed Slow spin of the whole network around the Y axis, in
 *                   radians per second. Negative reverses direction.
 *
 *   Depth of field (this.dof, "depth of field" GUI subfolder) - an analytic
 *   scattering blur done inside the Particles and Lines shaders themselves
 *   (no post-processing). Each dot/line works out its circle of confusion
 *   (CoC) from its distance to the camera and blurs itself. Both renderers
 *   share these uniform objects, so one slider drives both. All live.
 *     autoFocus     Keep the focus plane on the orbit target, so it follows
 *                   you when you zoom or orbit. Overrides focusDistance.
 *     focusDistance Distance from the camera (world units) that is sharp.
 *     focusRange    Half-depth of the sharp zone around the focus plane.
 *                   Larger = more of the web stays crisp.
 *     aperture      Lens opening. 0 = no blur at all; higher = blur grows
 *                   faster away from the focus plane.
 *     maxBlur       Largest blur diameter in CSS pixels. Caps the cost and
 *                   keeps very near dots from becoming huge discs.
 *     softness      Bokeh edge: 0 = crisp disc, 1 = soft, scattered glow.
 *     energy        0 = blurred things keep their brightness; 1 = they dim
 *                   as their light spreads over a larger area (physical).
 */
export default class Network {
    constructor() {
        this.orc = new Orchestrator();
        this.scene = this.orc.scene;
        this.debug = this.orc.debug;

        this.params = {
            // distribution (re-rolled by generate())
            count: 1000,
            spreadX: 7,
            spreadY: 6,
            spreadZ: 7,
            clustering: 3,
            clusterScale: 0.26,
            // motion (applied live every frame)
            speed: 0.12,
            amplitude: 0.35,
            noiseScale: 0.6,
            rotationSpeed: 0.02,
        };

        // Noise generator used for the per-frame drift (see update()).
        this.motionNoise = new SimplexNoise();
        // Our own clock, advanced by delta * speed, which drives the noise's 4th dimension.
        this.time = 0;

        // Depth-of-field uniforms. These exact objects are placed in both the
        // Particles and Lines materials, so editing .value updates both.
        this.dof = {
            uFocusDistance: { value: 3.6 },
            uFocusRange: { value: 0.8 },
            uAperture: { value: 2.6 },
            uMaxBlur: { value: 64 },
            uBlurSoftness: { value: 1.0 },
            uBlurEnergy: { value: 0.8 },
        };
        // Not a uniform: read in update() to drive uFocusDistance.
        this.dofParams = { autoFocus: false };

        // Parent of everything we draw, so the whole network can be transformed as one.
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Lines is created before Particles so lines are added to the scene first.
        this.lines = new Lines(this.group, this.dof);
        this.particles = new Particles(this.group, this.dof);

        this.generate();
        this.setDebug();
    }

    /**
     * Creates the particle layout. Called once on startup, and again whenever
     * a distribution param changes or "regenerate" is pressed.
     *
     * Produces three arrays (one entry per particle):
     *   basePositions  Resting position (x,y,z). Never changes after this.
     *   positions      Live position = base + animated offset. Rewritten
     *                  every frame in update(), and shared (by reference)
     *                  with the Particles GPU buffer.
     *   scales         Random size multiplier (0.5 - 1.5), so dots vary a bit.
     */
    generate() {
        const { count, spreadX, spreadY, spreadZ, clustering, clusterScale } =
            this.params;
        // A fresh noise field on every call, so "regenerate" gives a new layout.
        const densityNoise = new SimplexNoise();

        this.count = count;
        this.basePositions = new Float32Array(count * 3);
        this.positions = new Float32Array(count * 3);
        this.scales = new Float32Array(count);

        // Rejection sampling against ridged noise: points concentrate near the
        // noise's zero-crossings, forming the sheets and filaments of a web.
        //
        // In plain terms: pick a random point in the box, then roll a die to
        // decide whether to keep it. The odds of keeping it are high near the
        // noise's zero-crossings (the "ridges") and low elsewhere, so
        // accepted points pile up along those ridges. `clustering` is the
        // exponent that sharpens the odds; `clusterScale` stretches the noise
        // field in space.
        //
        // maxAttempts is a safety valve: with extreme settings almost every
        // candidate could be rejected, so after this many tries we accept
        // whatever comes next instead of looping (nearly) forever.
        const maxAttempts = count * 1000;
        let attempts = 0;
        let i = 0;
        while (i < count) {
            // Random candidate point, centred on the origin.
            const x = (Math.random() - 0.5) * spreadX;
            const y = (Math.random() - 0.5) * spreadY;
            const z = (Math.random() - 0.5) * spreadZ;

            // `ridge` is 1 exactly on a zero-crossing of the noise and falls
            // toward 0 the further the point is from one.
            const ridge =
                1 -
                Math.abs(
                    densityNoise.noise3d(
                        x * clusterScale,
                        y * clusterScale,
                        z * clusterScale,
                    ),
                );
            attempts++;
            // Reject (and try a new candidate) with probability 1 - ridge^clustering.
            if (
                attempts < maxAttempts &&
                Math.random() > Math.pow(ridge, clustering)
            ) {
                continue;
            }

            // Accepted: store the point and give it a random size multiplier.
            const i3 = i * 3;
            this.basePositions[i3] = x;
            this.basePositions[i3 + 1] = y;
            this.basePositions[i3 + 2] = z;
            this.scales[i] = 0.5 + Math.random();
            i++;
        }

        // Start at rest, then (re)build the GPU geometry for the dots.
        this.positions.set(this.basePositions);
        this.particles.setGeometry(this.positions, this.scales);
    }

    /**
     * Adds this class's controls to the lil-gui "network" folder.
     * Distribution sliders use onFinishChange (fires on release) rather than
     * onChange, because regenerating while dragging would re-roll the whole
     * layout on every tick and look like flickering.
     */
    setDebug() {
        if (this.debug.active) {
            this.debugFolder = this.debug.ui.addFolder("network");
            const regenerate = () => this.generate();

            // --- distribution: rebuilds the layout on release ---
            this.debugFolder
                .add(this.params, "count")
                .min(50)
                .max(1500)
                .step(1)
                .onFinishChange(regenerate);
            this.debugFolder
                .add(this.params, "spreadX")
                .min(1)
                .max(20)
                .step(0.1)
                .onFinishChange(regenerate);
            this.debugFolder
                .add(this.params, "spreadY")
                .min(1)
                .max(20)
                .step(0.1)
                .onFinishChange(regenerate);
            this.debugFolder
                .add(this.params, "spreadZ")
                .min(0.1)
                .max(20)
                .step(0.1)
                .onFinishChange(regenerate);
            this.debugFolder
                .add(this.params, "clustering")
                .min(0)
                .max(12)
                .step(0.01)
                .onFinishChange(regenerate);
            this.debugFolder
                .add(this.params, "clusterScale")
                .min(0.05)
                .max(2)
                .step(0.001)
                .onFinishChange(regenerate);
            // Button: re-rolls the random layout with the current settings.
            this.debugFolder.add(this, "generate").name("regenerate");

            // --- motion: read every frame in update(), so changes are live ---
            this.debugFolder
                .add(this.params, "speed")
                .min(0)
                .max(2)
                .step(0.001);
            this.debugFolder
                .add(this.params, "amplitude")
                .min(0)
                .max(2)
                .step(0.001);
            this.debugFolder
                .add(this.params, "noiseScale")
                .min(0)
                .max(3)
                .step(0.001);
            this.debugFolder
                .add(this.params, "rotationSpeed")
                .min(-0.5)
                .max(0.5)
                .step(0.001);

            // --- depth of field: shared uniforms, live ---
            const dofFolder = this.debugFolder.addFolder("depth of field");
            dofFolder.add(this.dofParams, "autoFocus");
            // .listen() keeps the slider in sync while autoFocus drives it.
            dofFolder
                .add(this.dof.uFocusDistance, "value")
                .name("focusDistance")
                .min(0.1)
                .max(20)
                .step(0.01)
                .listen();
            dofFolder
                .add(this.dof.uFocusRange, "value")
                .name("focusRange")
                .min(0)
                .max(10)
                .step(0.01);
            dofFolder
                .add(this.dof.uAperture, "value")
                .name("aperture")
                .min(0)
                .max(3)
                .step(0.001);
            dofFolder
                .add(this.dof.uMaxBlur, "value")
                .name("maxBlur")
                .min(0)
                .max(64)
                .step(0.1);
            dofFolder
                .add(this.dof.uBlurSoftness, "value")
                .name("softness")
                .min(0)
                .max(1)
                .step(0.001);
            dofFolder
                .add(this.dof.uBlurEnergy, "value")
                .name("energy")
                .min(0)
                .max(1)
                .step(0.001);
        }
    }

    /** Forwards window-resize events so each renderer can update its pixel-based uniforms. */
    resize() {
        this.particles.resize();
        this.lines.resize();
    }

    /**
     * Runs once per frame. Moves every particle, then tells the renderers to refresh.
     * @param {number} elapsed Total seconds since start (unused here; we keep our own `time`).
     * @param {number} delta   Seconds since the previous frame.
     */
    update(elapsed, delta) {
        const { speed, amplitude, noiseScale, rotationSpeed } = this.params;

        // Accumulate scaled time so changing speed doesn't make particles jump.
        // (Using elapsed * speed instead would teleport everything whenever
        // the slider moved, because the whole elapsed total would be rescaled.)
        this.time += delta * speed;
        const t = this.time;

        // Offsets are sampled from a 4D noise field around each base position,
        // so neighbours drift coherently while the field slowly evolves.
        //
        // Noise inputs are (x, y, z, time). Because the noise is smooth,
        // particles that are close together get similar offsets (they move as
        // a group), and each particle's offset changes gradually as `t` grows.
        // The result is in -1..1, which `amplitude` scales into world units.
        for (let i = 0; i < this.count; i++) {
            const i3 = i * 3;
            const bx = this.basePositions[i3];
            const by = this.basePositions[i3 + 1];
            const bz = this.basePositions[i3 + 2];
            // noiseScale zooms the field: larger = the field varies faster across space.
            const nx = bx * noiseScale;
            const ny = by * noiseScale;
            const nz = bz * noiseScale;

            // x, y and z each need an independent offset, so we sample the
            // field at three different places by shifting the input with
            // arbitrary constants (31.4, 47.2). Without that, all three axes
            // would get the same value and particles would only slide along
            // the diagonal.
            this.positions[i3] =
                bx + this.motionNoise.noise4d(nx, ny, nz, t) * amplitude;
            this.positions[i3 + 1] =
                by + this.motionNoise.noise4d(nx + 31.4, ny, nz, t) * amplitude;
            this.positions[i3 + 2] =
                bz + this.motionNoise.noise4d(nx, ny + 47.2, nz, t) * amplitude;
        }

        // Keep the focus plane on the orbit target so it follows zoom/orbit.
        if (this.dofParams.autoFocus) {
            const { instance, controls } = this.orc.camera;
            this.dof.uFocusDistance.value = instance.position.distanceTo(
                controls.target,
            );
        }

        // Slow spin of the whole network (dots and lines together).
        this.group.rotation.y += delta * rotationSpeed;

        // `positions` has changed: re-upload it for the dots, and rebuild the
        // line list from whichever pairs are currently close enough.
        this.particles.update();
        this.lines.update(this.positions, this.count);
    }
}
