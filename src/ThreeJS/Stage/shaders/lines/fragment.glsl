// Lines fragment shader: anti-aliased line colour and transparency.
// Used by src/ThreeJS/Stage/Network/Lines.js

uniform vec3 uColor;       // line tint (GUI: lines > color)
uniform float uOpacity;    // overall transparency (GUI: lines > opacity)
uniform float uWidth;      // line thickness in CSS pixels (GUI: lines > thickness)
uniform float uPixelRatio;

varying float vAlpha; // per-line fade: eases in as the two particles approach
varying float vEdge;  // signed pixel distance from the line's centre

void main() {
    float widthPx = uWidth * uPixelRatio;
    float halfWidth = max(widthPx, 1.0) * 0.5;
    // 1 inside the line, ramping to 0 over the last pixel at each edge (anti-aliasing).
    float coverage = clamp(halfWidth + 0.5 - abs(vEdge), 0.0, 1.0);

    // Sub-pixel widths are drawn 1px wide and dimmed proportionally.
    float alpha = coverage * min(widthPx, 1.0) * vAlpha * uOpacity;

    gl_FragColor = vec4(uColor, alpha);

    // Converts the linear colour to the output colour space (sRGB).
    #include <colorspace_fragment>
}
