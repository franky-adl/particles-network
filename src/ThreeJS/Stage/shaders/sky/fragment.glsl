// Sky fragment shader: gradient on the inside of the sky sphere.
// +Y (the zenith) is uZenithColor, -Y (the opposite point) is uOppositeColor.
// Used by src/ThreeJS/Stage/Sky.js

uniform vec3 uZenithColor;   // top of the sphere (GUI: sky > zenith)
uniform vec3 uOppositeColor; // bottom of the sphere (GUI: sky > opposite)

varying vec3 vDirection;

void main() {
    // y goes from -1 at the opposite point to +1 at the zenith. Mapping it to
    // 0..1 makes mix() walk evenly from one color to the other, which on the
    // sphere is a smooth gradient (fastest around the horizon, steady at the poles).
    float t = normalize(vDirection).y * 0.5 + 0.5;
    t = pow(t, 4.); // make the gradient more pronounced
    vec3 color = mix(uOppositeColor, uZenithColor, clamp(t, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);

    #include <colorspace_fragment>
}
