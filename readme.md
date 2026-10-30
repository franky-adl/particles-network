# Particles Network

A highly customizable 3D particle network visualization built with [Three.js](https://threejs.org/). Thousands of glowing particles drift organically through space on a smooth noise field, and nearby particles are linked by lines that form and break as they move, creating a living, web-like structure that slowly rotates.

![Particles Network](screencap.webp)

These can all be tweaked live through a [lil-gui](https://lil-gui.georgealways.com/) control panel:

- **Distribution** — particle count, spread, clustering
- **Motion** — speed, amplitude, noise scale, rotation
- **Dots** — color, size, opacity, glow
- **Lines** — near and far color, thickness, opacity, connection distance, connection cap, fade time
- **Depth of field** — auto focus, focus distance and range, aperture, blur size, softness, energy
- **Sky** — zenith and opposite colors

## Setup

Download [Node.js](https://nodejs.org/en/download/).
Run the following commands:

```bash
# Install dependencies (only the first time)
pnpm i

# Run the local server at localhost:5173
pnpm dev

# Build for production in the dist/ directory
pnpm build
```
