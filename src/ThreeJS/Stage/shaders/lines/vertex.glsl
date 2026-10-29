// Lines vertex shader: stretches one quad between two 3D points and widens it
// to a fixed width in screen pixels.
// Used by src/ThreeJS/Stage/Network/Lines.js

uniform vec2 uResolution;  // drawing-buffer size in physical pixels
uniform float uWidth;      // line thickness in CSS pixels (GUI: lines > thickness)
uniform float uPixelRatio; // converts CSS pixels to physical pixels

// Per-segment (instanced) data:
attribute vec3 instanceStart; // one end of the segment
attribute vec3 instanceEnd;   // the other end
attribute float instanceAlpha; // 0-1 fade based on how close the two particles are

varying float vAlpha;
varying float vEdge; // signed pixel distance from the line's centre, for anti-aliasing

// Moves `end` onto the near plane so segments crossing behind the camera
// don't project with a flipped direction.
void trimSegment(const in vec4 start, inout vec4 end) {
    float a = projectionMatrix[2][2];
    float b = projectionMatrix[3][2];
    float nearEstimate = -0.5 * b / a;
    float alpha = (nearEstimate - start.z) / (end.z - start.z);
    end.xyz = mix(start.xyz, end.xyz, alpha);
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
    // sideways (perpendicular) by an exact pixel amount.
    vec2 halfResolution = uResolution * 0.5;
    vec2 screenStart = clipStart.xy / clipStart.w * halfResolution;
    vec2 screenEnd = clipEnd.xy / clipEnd.w * halfResolution;
    vec2 dir = screenEnd - screenStart;
    // Guard against zero-length lines (both ends on the same pixel).
    dir = length(dir) > 1e-4 ? normalize(dir) : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);

    // 1px of padding on each side leaves room for the anti-aliased edge.
    float widthPx = max(uWidth * uPixelRatio, 1.0);
    float halfQuad = widthPx * 0.5 + 1.0;
    // position.y is -1 or 1 (which side of the line this corner is on).
    vEdge = position.y * halfQuad;
    vAlpha = instanceAlpha;

    // position.x is 0 or 1: pick the start or end of the segment, then push
    // the corner sideways by vEdge pixels. Converting pixels back to clip
    // space needs the division by half-resolution, and the * clip.w
    // cancels the perspective divide so the offset stays a constant pixel size.
    vec4 clip = mix(clipStart, clipEnd, position.x);
    clip.xy += normal * vEdge / halfResolution * clip.w;
    gl_Position = clip;
}
