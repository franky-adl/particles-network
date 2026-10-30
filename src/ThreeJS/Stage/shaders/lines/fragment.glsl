// Lines fragment shader: anti-aliased, depth-of-field-blurred capsule colour
// and transparency. Coverage is the soft distance to the segment, so out-of-
// focus ends are round caps instead of square butts.
// Used by src/ThreeJS/Stage/Network/Lines.js

uniform vec3 uColorNear;  // shortest lines (GUI: lines > color near)
uniform vec3 uColorFar;   // longest lines, at connectDistance (GUI: lines > color far)
uniform float uOpacity;   // overall transparency (GUI: lines > opacity)
uniform vec2 uResolution; // drawing-buffer size in physical pixels

varying float vCloseness; // 1 when the ends touch, 0 at connectDistance
varying float vRankFade; // cap crossfade: 1 inside the cap, 0 when the slot is lost
varying vec2 vScreenStart; // segment start in centered screen pixels
varying vec2 vScreenEnd;   // segment end in centered screen pixels
varying vec3 vBlurStart;   // start end: x = half-width px, y = edge softness px, z = brightness
varying vec3 vBlurEnd;     // end end: same layout as vBlurStart

void main() {
    // Same centered pixel space as the vertex shader's screenStart / screenEnd.
    vec2 frag = gl_FragCoord.xy - uResolution * 0.5;

    // Project the fragment onto the segment. Inside the span the distance is
    // lateral; past an endpoint it is the distance to that endpoint (the
    // semicircle of the capsule).
    vec2 ab = vScreenEnd - vScreenStart;
    float abLenSq = max(dot(ab, ab), 1e-8);
    float t = clamp(dot(frag - vScreenStart, ab) / abLenSq, 0.0, 1.0);
    float dist = length(frag - mix(vScreenStart, vScreenEnd, t));

    // Mix the two ends' blur so a line can still be sharp at one end and
    // blurred at the other; the cap uses that end's radius.
    vec3 blur = mix(vBlurStart, vBlurEnd, t);

    // 1 inside the line, easing to 0 across the edge band (softness px on each
    // side of the half-width). In focus the band is the usual 1px anti-aliasing;
    // out of focus the line is wider, its edge wider, and its brightness lower.
    float coverage = 1.0 - smoothstep(blur.x - blur.y, blur.x + blur.y, dist);
    if (coverage < 0.001) discard;

    // Same smoothstep as before: gentle at both ends of the length range, so a
    // line eases in as its particles approach and eases out as they drift apart.
    float fade = vCloseness * vCloseness * (3.0 - 2.0 * vCloseness);
    // Straight mix by length: touching particles are color near, a line as long
    // as connectDistance is color far.
    vec3 color = mix(uColorFar, uColorNear, smoothstep(0.6, 0.8, vCloseness));

    // vRankFade eases lines that are winning or losing the per-particle cap.
    // Colour stays on closeness, so a fading marginal line does not recolor.
    float alpha = coverage * blur.z * fade * vRankFade * uOpacity;

    gl_FragColor = vec4(color, alpha);

    // Converts the linear colour to the output colour space (sRGB).
    #include <colorspace_fragment>
}
