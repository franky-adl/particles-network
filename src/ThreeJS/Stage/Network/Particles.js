import * as THREE from "three";
import Orchestrator from "../../Orchestrator.js";
import vertexShader from "../shaders/particles/vertex.glsl";
import fragmentShader from "../shaders/particles/fragment.glsl";

/**
 * Particles
 * ---------
 * Draws the glowing dots of the network. It does NOT decide where the dots
 * are: Network owns the positions array and calls update() each frame so the
 * GPU sees the latest values. This class only turns those positions into
 * pixels.
 *
 * How it works:
 *   - The dots are a single THREE.Points object (one draw call for all of them).
 *   - Each dot is a square "point sprite". The fragment shader
 *     (shaders/particles/fragment.glsl) cuts it into a soft circle: a small
 *     bright core plus a fading halo.
 *   - The vertex shader (shaders/particles/vertex.glsl) sizes each dot in world
 *     units, so dots shrink with distance from the camera and stay the same
 *     apparent size at any screen resolution.
 *   - Blending is additive and depth writing is off, so overlapping dots (and
 *     lines) brighten each other like light instead of hiding one another.
 *     It also means draw order doesn't matter.
 *
 * Tweakable params (the uniforms below, shown in the "particles" GUI folder).
 * All are live: no regeneration is needed.
 *   color    Tint of the dots and their halo.
 *   size     Dot diameter in world units. Each dot is additionally multiplied
 *            by its own random scale (0.5 - 1.5, set by Network), so this is
 *            the average size.
 *   opacity  Overall transparency, 0 = invisible, 1 = fully opaque core.
 *   glow     Brightness of the soft halo around each core. 0 = hard little
 *            discs only; higher = bigger, brighter bloom-like halos.
 *
 * Depth of field: dots out of focus blur themselves. The vertex shader works
 * out each dot's circle of confusion from its depth and enlarges the sprite;
 * the fragment shader spreads the core and halo over that larger, softer
 * area. The controls live in Network's "depth of field" GUI folder because
 * Lines shares the same uniforms.
 */
export default class Particles {
    /**
     * @param {THREE.Object3D} parent Where to attach the Points (Network's group).
     * @param {object} dofUniforms Depth-of-field uniforms shared with Lines
     *        (created and exposed in the GUI by Network).
     */
    constructor(parent, dofUniforms) {
        this.orc = new Orchestrator();
        this.sizes = this.orc.sizes;
        this.debug = this.orc.debug;
        this.parent = parent;
        this.dofUniforms = dofUniforms;

        // The geometry is supplied later by Network.generate() via setGeometry(),
        // because it needs the particle positions, which Network creates.
        this.setMaterial();
        this.setDebug();
    }

    /**
     * Builds (or rebuilds) the GPU geometry from the particle data.
     * Called by Network.generate() whenever the layout is re-rolled.
     *
     * @param {Float32Array} positions xyz per particle. This exact array is
     *        uploaded as the vertex buffer, and Network keeps writing into it,
     *        so after each change we only need to flag it for re-upload (see update()).
     * @param {Float32Array} scales one size multiplier per particle,
     *        read by the vertex shader as the `aScale` attribute.
     */
    setGeometry(positions, scales) {
        // Free the previous layout's GPU buffers.
        this.geometry?.dispose();

        this.geometry = new THREE.BufferGeometry();
        // DynamicDrawUsage hints that this buffer is rewritten every frame.
        this.positionAttribute = new THREE.BufferAttribute(
            positions,
            3,
        ).setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute("position", this.positionAttribute);
        this.geometry.setAttribute(
            "aScale",
            new THREE.BufferAttribute(scales, 1),
        );

        // First call creates the Points object; later calls just swap its geometry.
        if (this.points) {
            this.points.geometry = this.geometry;
        } else {
            this.setPoints();
        }
    }

    /**
     * Creates the shader material. The uniforms here are the tweakable
     * params; the GUI edits them directly, so no extra wiring is needed.
     */
    setMaterial() {
        this.material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                uSize: { value: 0.05 }, // dot diameter, world units
                uViewportHeight: { value: 0 }, // drawing-buffer height in px; set by resize()
                uPixelRatio: { value: 1 }, // physical px per CSS px; set by resize()
                uColor: { value: new THREE.Color("#d6dbff") },
                uOpacity: { value: 0.9 },
                uGlow: { value: 0.5 },
                // Depth-of-field blur params, shared with Lines (see Network).
                ...this.dofUniforms,
            },
            // Partially transparent, light-like look (see class comment).
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        // Fill in uViewportHeight right away.
        this.resize();
    }

    /** Creates the Points object and adds it to the parent group. */
    setPoints() {
        this.points = new THREE.Points(this.geometry, this.material);
        // Positions are animated on the CPU, so the initial bounds go stale.
        // Without this, three.js could wrongly cull dots that drifted out of
        // the original bounding sphere.
        this.points.frustumCulled = false;
        // Draw after the lines (renderOrder 0) so dots sit on top of them.
        this.points.renderOrder = 1;
        this.parent.add(this.points);
    }

    /**
     * Adds this class's controls to the lil-gui "particles" folder.
     * debug.addColor (rather than .addColor directly) converts between the
     * color picker's sRGB and three.js's linear color space.
     */
    setDebug() {
        if (this.debug.active) {
            this.debugFolder = this.debug.ui.addFolder("particles");
            const uniforms = this.material.uniforms;

            this.debug.addColor(
                this.debugFolder,
                uniforms.uColor.value,
                "color",
            );
            this.debugFolder
                .add(uniforms.uSize, "value")
                .name("size")
                .min(0.005)
                .max(0.4)
                .step(0.001);
            this.debugFolder
                .add(uniforms.uOpacity, "value")
                .name("opacity")
                .min(0)
                .max(1)
                .step(0.001);
            this.debugFolder
                .add(uniforms.uGlow, "value")
                .name("glow")
                .min(0)
                .max(2)
                .step(0.001);
        }
    }

    /**
     * Called on window resize. The vertex shader needs the drawing-buffer height
     * in physical pixels (CSS height * pixel ratio) to convert the world-space
     * size into a gl_PointSize in pixels.
     */
    resize() {
        this.material.uniforms.uViewportHeight.value =
            this.sizes.height * this.sizes.pixelRatio;
        this.material.uniforms.uPixelRatio.value = this.sizes.pixelRatio;
    }

    /**
     * Called every frame by Network after it has rewritten the positions array.
     * Flags the buffer so three.js re-uploads it to the GPU on the next render.
     */
    update() {
        this.positionAttribute.needsUpdate = true;
    }
}
