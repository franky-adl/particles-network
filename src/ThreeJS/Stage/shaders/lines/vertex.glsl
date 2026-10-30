// Lines vertex shader: stretches one quad between two 3D points and widens it
// to a fixed width in screen pixels, then extends it past each end into a
// capsule so the circle of confusion rounds the butts instead of leaving
// squares.
// Used by src/ThreeJS/Stage/Network/Lines.js

#include "../dof/coc.glsl"

uniform vec2 uResolution;  // drawing-buffer size in physical pixels
uniform float uWidth;      // line thickness in CSS pixels (GUI: lines > thickness)
uniform float uPixelRatio; // converts CSS pixels to physical pixels

// Per-segment (instanced) data:
attribute vec3 instanceStart; // one end of the segment
attribute vec3 instanceEnd;   // the other end
attribute float instanceCloseness; // 1 when the ends touch, 0 at connectDistance
attribute float instanceRankFade; // 1 inside the cap; last slot crossfades toward 0

varying float vCloseness;
varying float vRankFade;
varying vec2 vScreenStart; // segment start in centered screen pixels
varying vec2 vScreenEnd;   // segment end in centered screen pixels
varying vec3 vBlurStart;   // start end: x = half-width px, y = edge softness px, z = brightness
varying vec3 vBlurEnd;     // end end: same layout as vBlurStart

// Moves `end` onto the near plane so segments crossing behind the camera
// don't project with a flipped direction.
void trimSegment(const in vec4 start, inout vec4 end) {
    float a = projectionMatrix[2][2];
    float b = projectionMatrix[3][2];
    float nearEstimate = -0.5 * b / a;
    float alpha = (nearEstimate - start.z) / (end.z - start.z);
    end.xyz = mix(start.xyz, end.xyz, alpha);
}

// Blur params at one endpoint: half-width, soft edge, and energy-dimmed brightness.
vec3 blurAtDepth(float depth, float sharpWidthPx, float thinDimming) {
    float coc = computeCoc(depth, uResolution.y, uPixelRatio);
    // Blurring spreads a line by the CoC: wider strip, softer edge, dimmer
    // (same light over a bigger area). Caps use the same radius so the end
    // is a semicircle matching the particle disc.
    float halfWidthPx = 0.5 * (sharpWidthPx + coc);
    float edgePx = 0.5 + uBlurSoftness * coc * 0.5; // 0.5 = plain 1px anti-aliasing
    float energy = pow(sharpWidthPx / (sharpWidthPx + coc), uBlurEnergy);
    return vec3(halfWidthPx, edgePx, thinDimming * energy);
}

void main() {
    // Both ends in view space (camera at the origin, looking down -z).
    vec4 start = modelViewMatrix * vec4(instanceStart, 1.0);
    vec4 end = modelViewMatrix * vec4(instanceEnd, 1.0);

    // If exactly one end is behind the camera, clip it to the near plane.
    if (start.z < 0.0 && end.z >= 0.0) {
        trimSegment(start, end);
    } else if (end.z < 0.0 && start.z >= 0.0) {
        trimSegment(end, start);
    }

    vec4 clipStart = projectionMatrix * start;
    vec4 clipEnd = projectionMatrix * end;

    // Work out the line's direction on screen, in pixels, so we can offset
    // sideways (perpendicular) and along the segment by exact pixel amounts.
    vec2 halfResolution = uResolution * 0.5;
    vec2 screenStart = clipStart.xy / clipStart.w * halfResolution;
    vec2 screenEnd = clipEnd.xy / clipEnd.w * halfResolution;
    vec2 dir = screenEnd - screenStart;
    // Guard against zero-length lines (both ends on the same pixel).
    dir = length(dir) > 1e-4 ? normalize(dir) : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);

    // --- Analytic scattering blur --------------------------------------------
    // CoC at each end (depths can differ), so one line can be sharp at one end
    // and blurred at the other. Written identically from every vertex so the
    // fragment shader gets the true endpoints without perspective warp.
    float rawWidthPx = uWidth * uPixelRatio;
    float sharpWidthPx = max(rawWidthPx, 1.0); // sub-pixel lines are drawn 1px wide...
    float thinDimming = min(rawWidthPx, 1.0);  // ...and dimmed instead

    vBlurStart = blurAtDepth(-start.z, sharpWidthPx, thinDimming);
    vBlurEnd = blurAtDepth(-end.z, sharpWidthPx, thinDimming);
    vScreenStart = screenStart;
    vScreenEnd = screenEnd;
    vCloseness = instanceCloseness;
    vRankFade = instanceRankFade;

    // The quad must cover the blurred strip, its soft edge, and a semicircle
    // past this endpoint. Pick this corner's blur radius for the pad.
    vec3 blur = mix(vBlurStart, vBlurEnd, position.x);
    float halfQuad = blur.x + blur.y + 0.5;

    // position.x is 0 or 1: pick the start or end of the segment.
    // position.y is -1 or 1: which side of the line.
    // Push sideways for width, and along the segment for the round cap.
    vec4 clip = mix(clipStart, clipEnd, position.x);
    vec2 offsetPx = normal * position.y * halfQuad
        + dir * (position.x * 2.0 - 1.0) * halfQuad;
    // Converting pixels back to clip space needs the division by
    // half-resolution, and the * clip.w cancels the perspective divide so the
    // offset stays a constant pixel size.
    clip.xy += offsetPx / halfResolution * clip.w;
    gl_Position = clip;
}
