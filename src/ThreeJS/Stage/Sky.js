import * as THREE from "three";
import Orchestrator from "../Orchestrator.js";
import vertexShader from "./shaders/sky/vertex.glsl";
import fragmentShader from "./shaders/sky/fragment.glsl";
import { SKY_LAYER } from "./SkyBehindPass.js";

// Sits well inside the camera's far plane (100). The mesh is recentered on
// the camera, so every point on it stays this far away and is never clipped.
const RADIUS = 40;

/**
 * Sky
 * ---
 * A sphere drawn from the inside, centered on the camera, so it always fills
 * the background. The color depends only on direction: the zenith (+Y) is one
 * color, the opposite point (-Y) is another, and every direction in between is
 * a mix of the two.
 *
 * The mesh is not rotated, so +Y stays world up while you orbit. It lives on
 * SKY_LAYER rather than the network's layer, and it is composited after bloom
 * (see SkyBehindPass). A bright zenith would otherwise flood the bloom pass
 * and wash the gradient out.
 *
 * Tweakable params (GUI folder "sky"):
 *   zenith    Color at the top of the sphere.
 *   opposite  Color at the bottom of the sphere.
 */
export default class Sky {
    constructor() {
        this.orc = new Orchestrator();
        this.scene = this.orc.scene;
        this.camera = this.orc.camera;
        this.debug = this.orc.debug;

        this.setMesh();
        this.setDebug();
    }

    setMesh() {
        this.geometry = new THREE.SphereGeometry(RADIUS, 48, 32);
        this.material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                uZenithColor: { value: new THREE.Color("#1e32c8") },
                uOppositeColor: { value: new THREE.Color("#02040c") },
            },
            side: THREE.BackSide,
            depthWrite: false,
            depthTest: false,
        });

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.name = "sky";
        this.mesh.frustumCulled = false;
        // Behind the network when both are drawn in one pass (postprocessing off).
        this.mesh.renderOrder = -1;
        this.mesh.layers.set(SKY_LAYER);
        this.scene.add(this.mesh);
    }

    setDebug() {
        if (this.debug.active) {
            this.debugFolder = this.debug.ui.addFolder("sky");
            const uniforms = this.material.uniforms;

            this.debug.addColor(
                this.debugFolder,
                uniforms.uZenithColor.value,
                "zenith",
            );
            this.debug.addColor(
                this.debugFolder,
                uniforms.uOppositeColor.value,
                "opposite",
            );
        }
    }

    /**
     * Keeps the sphere wrapped around the camera so orbiting never leaves it
     * or pushes the far side past the far plane. Called each frame before render.
     */
    update() {
        this.mesh.position.copy(this.camera.instance.position);
    }
}
