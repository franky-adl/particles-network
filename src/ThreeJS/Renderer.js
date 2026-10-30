import * as THREE from "three";
import Orchestrator from "./Orchestrator.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export default class Renderer {
    constructor() {
        this.orc = new Orchestrator();
        this.canvas = this.orc.canvas;
        this.sizes = this.orc.sizes;
        this.scene = this.orc.scene;
        this.camera = this.orc.camera;
        this.debug = this.orc.debug;

        // toggle to true if you want to use postprocessing effects
        this.usePostProcessing = true;

        this.setInstance();
        if (this.usePostProcessing) {
            this.setPostProcessing();
        }
    }

    setInstance() {
        this.instance = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
        });
        // UnrealBloomPass expects tone mapping. OutputPass applies it last,
        // using these renderer settings.
        this.instance.toneMapping = THREE.ACESFilmicToneMapping;
        this.instance.toneMappingExposure = 1;
        // Uncomment to enable shadows
        // this.instance.shadowMap.enabled = true
        // this.instance.shadowMap.type = THREE.PCFShadowMap
        this.instance.setClearColor("#211d20");
        this.instance.setSize(this.sizes.width, this.sizes.height);
        this.instance.setPixelRatio(this.sizes.pixelRatio);
    }

    setPostProcessing() {
        this.composer = new EffectComposer(this.instance);
        this.renderPass = new RenderPass(this.scene, this.camera.instance);

        // strength, radius (0–1), threshold. Read live each frame, so the GUI
        // can edit the pass directly.
        this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(this.sizes.width, this.sizes.height),
            1.5,
            0.4,
            0.2,
        );
        this.outputPass = new OutputPass();

        this.composer.addPass(this.renderPass);
        // Add the passes you want to use here, before the outputPass
        this.composer.addPass(this.bloomPass);
        this.composer.addPass(this.outputPass);

        this.setDebug();
    }

    /**
     * Bloom controls. strength / radius / threshold are copied into the pass
     * shaders on every render, and enabled skips the pass entirely.
     */
    setDebug() {
        if (this.debug.active) {
            this.debugFolder = this.debug.ui.addFolder("bloom");
            this.debugFolder.add(this.bloomPass, "enabled");
            this.debugFolder
                .add(this.bloomPass, "strength")
                .min(0)
                .max(3)
                .step(0.01);
            this.debugFolder
                .add(this.bloomPass, "radius")
                .min(0)
                .max(1)
                .step(0.01);
            this.debugFolder
                .add(this.bloomPass, "threshold")
                .min(0)
                .max(1)
                .step(0.01);
            this.debugFolder
                .add(this.instance, "toneMappingExposure")
                .name("exposure")
                .min(0)
                .max(3)
                .step(0.01);
        }
    }

    resize() {
        this.instance.setSize(this.sizes.width, this.sizes.height);
        this.instance.setPixelRatio(this.sizes.pixelRatio);

        if (this.usePostProcessing) {
            this.composer.setSize(this.sizes.width, this.sizes.height);
            this.composer.setPixelRatio(this.sizes.pixelRatio);
        }
    }

    update() {
        if (this.usePostProcessing) {
            this.composer.render();
        } else {
            this.instance.render(this.scene, this.camera.instance);
        }
    }
}
