// Particles fragment shader: turns each square point sprite into a soft glowing dot.
// Radii are in pixels, already enlarged by the depth-of-field blur in the vertex shader.
// Used by src/ThreeJS/Stage/Network/Particles.js

uniform vec3 uColor;    // dot + halo tint (GUI: particles > color)
uniform float uOpacity; // overall transparency (GUI: particles > opacity)
uniform float uGlow;    // halo strength (GUI: particles > glow)

varying float vSize; // sprite diameter in px
varying vec3 vCore;  // core disc:  x = radius px, y = edge softness px, z = brightness
varying vec2 vHalo;  // halo:       x = radius px, y = brightness

void main() {
    // Distance from the sprite's centre, in pixels (0 at the middle).
    float r = length(gl_PointCoord - 0.5) * vSize;

    // Core: solid disc with a soft edge centred on its radius. When out of
    // focus the disc is larger, its edge wider and its brightness lower.
    float core = (1.0 - smoothstep(vCore.x - vCore.y, vCore.x + vCore.y, r)) * vCore.z;
    // Halo: smooth falloff from the centre to its radius. The cubic power
    // concentrates the light near the core so it reads as a glow.
    float halo = pow(1.0 - smoothstep(0.0, vHalo.x, r), 3.0) * uGlow * vHalo.y;

    float alpha = (core + halo) * uOpacity;
    // Skip fully transparent pixels (the square's corners).
    if (alpha < 0.001) discard;

    gl_FragColor = vec4(uColor, alpha);

    // Converts the linear colour to the output colour space (sRGB).
    #include <colorspace_fragment>
}
