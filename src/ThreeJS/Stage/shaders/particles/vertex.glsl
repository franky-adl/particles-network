// Particles vertex shader: positions each dot and sizes it in pixels.
// Used by src/ThreeJS/Stage/Network/Particles.js

uniform float uSize;           // dot diameter in world units (GUI: particles > size)
uniform float uViewportHeight; // drawing-buffer height in physical pixels

attribute float aScale;        // per-particle size multiplier (random 0.5 - 1.5)

void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;

    // uSize is a world-space diameter; project it to pixels so particles keep
    // the same apparent size regardless of resolution or pixel ratio.
    //
    // projectionMatrix[1][1] is cot(fov / 2), the vertical scale of the
    // perspective projection. Dividing by -viewPosition.z (distance in front
    // of the camera) gives the perspective shrink: far dots are smaller.
    gl_PointSize = uSize * aScale * uViewportHeight * 0.5 * projectionMatrix[1][1] / -viewPosition.z;
}
