import * as THREE from "three";
import Orchestrator from "../Orchestrator.js";

export default class Environment {
    constructor() {
        this.orc = new Orchestrator();
        this.scene = this.orc.scene;
        this.resources = this.orc.resources;
        this.debug = this.orc.debug;

        // Debug
        if (this.debug.active) {
            this.debugFolder = this.debug.ui.addFolder("environment");
        }

        this.setBackground();
    }

    setBackground() {
        this.scene.background = new THREE.Color("#030c12");

        // Debug
        if (this.debug.active) {
            this.debug.addColor(
                this.debugFolder,
                this.scene.background,
                "background",
            );
        }
    }
}
