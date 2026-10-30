// Lines fragment shader: anti-aliased, depth-of-field-blurred line colour and transparency.
// Used by src/ThreeJS/Stage/Network/Lines.js

uniform vec3 uColor;       // line tint (GUI: lines > color)
uniform float uOpacity;    // overall transparency (GUI: lines > opacity)

varying float vAlpha; // per-line fade: eases in as the two particles approach
varying float vEdge;  // signed pixel distance from the line's centre
varying vec3 vBlur;   // x = half-width px, y = edge softness px, z = brightness

void main() {
    // 1 inside the line, easing to 0 across the edge band (softness px on each
    // side of the half-width). In focus the band is the usual 1px anti-aliasing;
    // out of focus the line is wider, its edge wider, and its brightness lower.
    float coverage = 1.0 - smoothstep(vBlur.x - vBlur.y, vBlur.x + vBlur.y, abs(vEdge));

    float alpha = coverage * vBlur.z * vAlpha * uOpacity;

    gl_FragColor = vec4(uColor, alpha);

    // Converts the linear colour to the output colour space (sRGB).
    #include <colorspace_fragment>
}
