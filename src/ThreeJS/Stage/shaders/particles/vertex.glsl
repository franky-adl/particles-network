// Particles vertex shader: positions each dot, sizes it in pixels, and works out
// how much it should be blurred by depth of field.
// Used by src/ThreeJS/Stage/Network/Particles.js

#include "../dof/coc.glsl"

uniform float uSize;           // dot diameter in world units (GUI: particles > size)
uniform float uViewportHeight; // drawing-buffer height in physical pixels
uniform float uPixelRatio;     // physical pixels per CSS pixel

attribute float aScale;        // per-particle size multiplier (random 0.5 - 1.5)

varying float vSize;  // final sprite diameter in px (so the fragment shader can get px units)
varying vec3 vCore;   // core disc:  x = radius px, y = edge softness px, z = brightness
varying vec2 vHalo;   // halo:       x = radius px, y = brightness

void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;

    // uSize is a world-space diameter; project it to pixels so particles keep
    // the same apparent size regardless of resolution or pixel ratio.
    //
    // projectionMatrix[1][1] is cot(fov / 2), the vertical scale of the
    // perspective projection. Dividing by -viewPosition.z (distance in front
    // of the camera) gives the perspective shrink: far dots are smaller.
    float sharpSize = uSize * aScale * uViewportHeight * 0.5 * projectionMatrix[1][1] / -viewPosition.z;
    float halfSharp = sharpSize * 0.5;

    // --- Analytic scattering blur --------------------------------------------
    // An out-of-focus point of light turns into a disc of confusion with
    // diameter `coc`. We model the dot as two layers (core + halo), grow each
    // one's radius by that disc, and soften its edge. All of it is closed-form,
    // so the blur costs nothing extra per pixel.
    float coc = computeCoc(-viewPosition.z, uViewportHeight, uPixelRatio);
    float cocRadius = coc * 0.5;

    // Core. In focus: radius 0.2 * halfSharp with an edge 0.08 * halfSharp wide
    // (identical to the original look). Blurred: the radius and the edge both
    // widen; radii add "in quadrature" so the area grows by the CoC's area.
    float coreRadius = 0.2 * halfSharp;
    float coreEdge = 0.08 * halfSharp;
    float blurredCoreRadius = sqrt(coreRadius * coreRadius + cocRadius * cocRadius);
    float blurredCoreEdge = sqrt(coreEdge * coreEdge + pow(uBlurSoftness * cocRadius, 2.0));
    // Same light over a bigger area = dimmer. Ratio of areas, eased by uBlurEnergy.
    float coreEnergy = pow(coreRadius * coreRadius / max(blurredCoreRadius * blurredCoreRadius, 1e-6), uBlurEnergy);

    // Halo: same idea, no extra edge softening needed (it is already a smooth falloff).
    float blurredHaloRadius = sqrt(halfSharp * halfSharp + cocRadius * cocRadius);
    float haloEnergy = pow(halfSharp * halfSharp / max(blurredHaloRadius * blurredHaloRadius, 1e-6), uBlurEnergy);

    // The sprite must be big enough to contain the blurred halo plus soft edges.
    float pad = uBlurSoftness * cocRadius + 0.1 * halfSharp;
    float spriteSize = 2.0 * (blurredHaloRadius + pad);
    gl_PointSize = spriteSize;

    vSize = spriteSize;
    vCore = vec3(blurredCoreRadius, blurredCoreEdge, coreEnergy);
    vHalo = vec2(blurredHaloRadius, haloEnergy);
}
