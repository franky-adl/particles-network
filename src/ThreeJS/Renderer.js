import * as THREE from "three";
import Orchestrator from "./Orchestrator.js";
import { SKY_LAYER } from "./Stage/SkyBehindPass.js";

export default class Renderer {
    constructor() {
        this.orc = new Orchestrator();
        this.canvas = this.orc.canvas;
        this.sizes = this.orc.sizes;
        this.scene = this.orc.scene;
        this.camera = this.orc.camera;

        this.setInstance();
    }

    setInstance() {
        this.instance = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
        });
        // Uncomment to use tone mapping
        // this.instance.toneMapping = THREE.ACESFilmicToneMapping;
        // this.instance.toneMappingExposure = 1.75;
        // Uncomment to enable shadows
        // this.instance.shadowMap.enabled = true
        // this.instance.shadowMap.type = THREE.PCFShadowMap
        this.instance.setClearColor("#211d20");
        this.instance.setSize(this.sizes.width, this.sizes.height);
        this.instance.setPixelRatio(this.sizes.pixelRatio);
    }

    resize() {
        this.instance.setSize(this.sizes.width, this.sizes.height);
        this.instance.setPixelRatio(this.sizes.pixelRatio);
    }

    update() {
        const camera = this.camera.instance;
        // The sky sphere sits on its own layer. Include it so the backdrop is drawn.
        camera.layers.enable(SKY_LAYER);
        this.instance.render(this.scene, camera);
        camera.layers.disable(SKY_LAYER);
    }
}
