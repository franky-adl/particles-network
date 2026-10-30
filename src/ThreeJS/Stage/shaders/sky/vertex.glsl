// Sky vertex shader: direction of each point on the sphere, used to pick a
// color between the zenith and the opposite point.
// Used by src/ThreeJS/Stage/Sky.js

varying vec3 vDirection;

void main() {
    // Rotation and scale only. The sphere is moved onto the camera every
    // frame; leaving translation out keeps this direction stable.
    vDirection = mat3(modelMatrix) * position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
