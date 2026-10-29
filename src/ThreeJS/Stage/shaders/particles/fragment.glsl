// Particles fragment shader: turns each square point sprite into a soft glowing dot.
// Used by src/ThreeJS/Stage/Network/Particles.js

uniform vec3 uColor;    // dot + halo tint (GUI: particles > color)
uniform float uOpacity; // overall transparency (GUI: particles > opacity)
uniform float uGlow;    // halo strength (GUI: particles > glow)

void main() {
    // Distance from the sprite's centre: 0 at the middle, 0.5 at the edge midpoints.
    float d = length(gl_PointCoord - 0.5);

    // Core: solid disc with a slightly soft edge (full inside 0.06, gone by 0.14).
    float core = 1.0 - smoothstep(0.06, 0.14, d);
    // Halo: smooth falloff from centre to the sprite edge. The cubic power
    // concentrates the light near the core so it reads as a glow.
    float halo = pow(1.0 - smoothstep(0.0, 0.5, d), 3.0) * uGlow;

    float alpha = (core + halo) * uOpacity;
    // Skip fully transparent pixels (the square's corners).
    if (alpha < 0.001) discard;

    gl_FragColor = vec4(uColor, alpha);

    // Converts the linear colour to the output colour space (sRGB).
    #include <colorspace_fragment>
}
