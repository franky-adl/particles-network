import { Color, ShaderMaterial, AdditiveBlending } from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// The sky mesh is the only object on this layer. The network stays on layer 0,
// which is what the bloom pass renders.
export const SKY_LAYER = 1;

/**
 * Draws the sky sphere behind an already-rendered network.
 *
 * The bloom pass has already run on the network alone (black background).
 * This pass renders the sky into the write buffer, then adds the network
 * on top. Adding works because the dots and lines are additive light: on
 * black, their buffer *is* the light they contribute.
 *
 * Runs before OutputPass, so tone mapping still applies to the sky and the
 * network together.
 */
export default class SkyBehindPass extends Pass {
    /**
     * @param {THREE.Scene} scene Scene that contains the sky mesh.
     * @param {THREE.Camera} camera Perspective camera used for the sky sphere.
     */
    constructor(scene, camera) {
        super();

        this.scene = scene;
        this.camera = camera;
        this.needsSwap = true;

        this._oldClearColor = new Color();

        this.blendMaterial = new ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
            },
            vertexShader: /* glsl */ `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform sampler2D tDiffuse;
                varying vec2 vUv;
                void main() {
                    gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);
                }
            `,
            blending: AdditiveBlending,
            // ONE, ONE regardless of alpha, so the whole network color is added.
            premultipliedAlpha: true,
            depthTest: false,
            depthWrite: false,
            transparent: true,
        });
        this.fsQuad = new FullScreenQuad(this.blendMaterial);
    }

    render(renderer, writeBuffer, readBuffer) {
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;

        renderer.getClearColor(this._oldClearColor);
        const oldClearAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 1);

        const previousMask = this.camera.layers.mask;
        // Sky only. The network stays on layer 0, already in readBuffer.
        this.camera.layers.set(SKY_LAYER);

        try {
            renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
            renderer.clear(true, true, true);
            renderer.render(this.scene, this.camera);

            this.blendMaterial.uniforms.tDiffuse.value = readBuffer.texture;
            renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
            this.fsQuad.render(renderer);
        } finally {
            this.camera.layers.mask = previousMask;
            renderer.setClearColor(this._oldClearColor, oldClearAlpha);
            renderer.autoClear = oldAutoClear;
        }
    }
}
