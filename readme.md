# Particles Network

An interactive 3D particle network visualization built with [Three.js](https://threejs.org/). Thousands of glowing particles drift organically through space on a smooth noise field, and nearby particles are linked by lines that form and break as they move, creating a living, web-like structure that slowly rotates.

Distribution (particle count, spread, clustering) and motion (speed, amplitude, noise scale, rotation) can all be tweaked live through a [lil-gui](https://lil-gui.georgealways.com/) control panel.

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
