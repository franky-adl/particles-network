// Shared depth-of-field chunk: circle of confusion (CoC) from view-space depth.
// Pulled into the vertex shaders with `#include "../dof/coc.glsl"` (vite-plugin-glsl).
// The uniforms are shared by Particles and Lines and edited from Network's
// "depth of field" GUI folder (see src/ThreeJS/Stage/Network/Network.js).
//
// Instead of a post-process blur, each particle / line segment blurs itself:
// the vertex shader asks this chunk "how big is my CoC?", then enlarges the
// sprite / quad and the fragment shader spreads the light over that bigger
// area (analytic scattering blur).

uniform float uFocusDistance; // view-space distance (world units) that is perfectly sharp
uniform float uFocusRange;    // half-depth of the zone around the focus that stays sharp
uniform float uAperture;      // lens opening: how fast blur grows away from focus
uniform float uMaxBlur;       // upper limit of the CoC diameter, in CSS pixels
uniform float uBlurSoftness;  // 0 = crisp bokeh disc edge, 1 = very soft, scattered edge
uniform float uBlurEnergy;    // 0 = blur keeps brightness, 1 = blur dims like real light spreading out

// Returns the CoC diameter in physical (drawing-buffer) pixels.
//
//   depth          distance in front of the camera (positive, = -viewPosition.z)
//   viewportHeight drawing-buffer height in physical pixels
//   pixelRatio     physical pixels per CSS pixel (converts uMaxBlur)
//
// Thin-lens behaviour: the CoC grows with |depth - focus| / depth, so
// objects in FRONT of the focus plane blur faster than objects the same
// distance behind it, just like a real lens. Scaling by viewportHeight
// keeps the look identical at any resolution.
float computeCoc(float depth, float viewportHeight, float pixelRatio) {
    float d = max(depth, 1e-3);
    float defocus = max(abs(d - uFocusDistance) - uFocusRange, 0.0) / d;
    float coc = uAperture * viewportHeight * 0.05 * defocus;
    return min(coc, uMaxBlur * pixelRatio);
}
