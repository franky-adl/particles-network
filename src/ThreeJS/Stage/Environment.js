import Sky from "./Sky.js";

/**
 * Backdrop of the stage. The sky sphere is the whole environment for now.
 */
export default class Environment {
    constructor() {
        this.sky = new Sky();
    }

    update() {
        this.sky.update();
    }
}
