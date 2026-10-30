import Orchestrator from "../Orchestrator.js";
import Environment from "./Environment.js";
import Network from "./Network/Network.js";

export default class Stage {
    constructor() {
        this.orc = new Orchestrator();
        this.scene = this.orc.scene;

        this.resources = this.orc.resources;
        // Wait for resources
        this.orc.emitter.on("ready", () => {
            // Setup
            this.environment = new Environment();
            this.network = new Network();
        });
    }

    resize() {
        this.network?.resize();
    }

    // both time params are measured in seconds
    update(elapsed, delta) {
        // call stage elements' update methods if necessary
        this.environment?.update();
        this.network?.update(elapsed, delta);
    }
}
