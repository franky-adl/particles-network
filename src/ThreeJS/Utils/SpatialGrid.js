// Neighbour offsets for the "half-shell" search: the 13 cells that come AFTER a
// cell in (z, y, x) order. Of the 26 cells around a cell, each pair of
// neighbouring cells appears in exactly one of the two directions, so by only
// ever looking "forward" every pair of particles in different cells is visited
// once instead of twice. (Pairs inside the same cell are handled separately.)
const HALF_SHELL = [];
for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dz > 0 || (dz === 0 && (dy > 0 || (dy === 0 && dx > 0)))) {
                HALF_SHELL.push(dx, dy, dz);
            }
        }
    }
}
const HALF_SHELL_COUNT = HALF_SHELL.length / 3; // 13

/**
 * SpatialGrid
 * -----------
 * Finds every pair of points that are closer than a given distance, without
 * comparing every point against every other point.
 *
 * The problem: checking all pairs costs O(n²) (600 points = 180,000 checks per
 * frame, 1500 points = over 1 million). Two points can only be within
 * `maxDistance` of each other if they are in the same or in adjacent cells of
 * a grid whose cells are at least `maxDistance` wide, so most pairs never need
 * to be looked at. With roughly evenly spread points the cost becomes O(n).
 *
 * This is the classic "cell list" / "uniform grid" method. A flat grid is used
 * rather than a hash table or tree because the points live in a small bounded
 * box and the search radius is the same for all of them.
 *
 * How to use it (every frame, since the points move):
 *
 *   const grid = new SpatialGrid();
 *   grid.build(positions, count, maxDistance);
 *   grid.forEachPair(positions, maxDistance, (i, j, distanceSq) => { ... });
 *
 *   positions    Float32Array of xyz triples (x0,y0,z0,x1,y1,z1,...).
 *   count        How many points of `positions` to use.
 *   maxDistance  Pairs with distance < maxDistance are reported.
 *   callback     Called once per close pair (never twice for the same pair,
 *                never for a point with itself). i and j are point indices;
 *                distanceSq is the SQUARED distance, so take Math.sqrt() only
 *                if you need the real distance.
 *
 * How build() works (a "counting sort" of the points by cell, using three
 * passes over the points and no per-frame memory allocation):
 *   1. Measure the bounding box of the points and work out a grid size.
 *   2. Count how many points fall in each cell (histogram).
 *   3. Turn the counts into start offsets with a running total (prefix sum).
 *   4. Write each point's index into its cell's slot of one flat array.
 * Afterwards the points of cell `c` are sortedIndices[cellStart[c] ...
 * cellStart[c + 1] - 1], and the search just walks those small ranges.
 *
 * Every array is allocated once and reused; they only grow if a frame needs
 * more room than any earlier frame did.
 */
export default class SpatialGrid {
    constructor() {
        // The grid is never allowed to have much more than a few cells per
        // point. Clearing and walking a grid that is mostly empty cells would
        // cost more than it saves, so if maxDistance is tiny compared to the
        // box, cells are made bigger than needed instead. (Bigger cells are
        // still correct, they just test a few extra candidate pairs.)
        this.minCellsLimit = 4096;
        this.cellsPerPointLimit = 4;

        // Grid layout, set by build()
        this.minX = 0;
        this.minY = 0;
        this.minZ = 0;
        this.inverseCellSize = 1;
        this.cellsX = 1;
        this.cellsY = 1;
        this.cellsZ = 1;

        // Reused buffers (grown on demand, see build())
        this.cellStart = new Int32Array(0); // cellCount + 1 entries
        this.cursor = new Int32Array(0); // write position per cell while scattering
        this.cellOfPoint = new Int32Array(0); // which cell each point is in
        this.sortedIndices = new Int32Array(0); // point indices grouped by cell

        // Scratch list of non-empty "forward" neighbour cells for the current cell
        this.neighbourCells = new Int32Array(HALF_SHELL_COUNT);
    }

    /**
     * Sorts the points into grid cells. Call once per frame, after the points
     * have moved and before forEachPair().
     *
     * @param {Float32Array} positions xyz per point
     * @param {number} count number of points
     * @param {number} cellSize the smallest allowed cell width; pass the same
     *        distance you will give forEachPair() (the grid may choose a
     *        larger one if that is needed to keep the grid small)
     */
    build(positions, count, cellSize) {
        // --- 1. Bounding box of the points ---
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        for (let i = 0, i3 = 0; i < count; i++, i3 += 3) {
            const x = positions[i3];
            const y = positions[i3 + 1];
            const z = positions[i3 + 2];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
        if (count === 0) {
            minX = minY = minZ = maxX = maxY = maxZ = 0;
        }

        // --- 2. Choose the grid size ---
        // Cells must be at least `cellSize` wide so that any two points closer
        // than that are guaranteed to sit in the same or in adjacent cells.
        // The tiny extra factor protects against floating-point rounding for
        // pairs that are almost exactly `cellSize` apart.
        let size = Math.max(cellSize, 1e-6) * 1.000001;
        const maxCells = Math.max(
            this.minCellsLimit,
            count * this.cellsPerPointLimit,
        );
        let cellsX, cellsY, cellsZ;
        // Make cells 26% wider (= half as many cells in 3D) until the grid fits.
        while (true) {
            const inverse = 1 / size;
            cellsX = Math.floor((maxX - minX) * inverse) + 1;
            cellsY = Math.floor((maxY - minY) * inverse) + 1;
            cellsZ = Math.floor((maxZ - minZ) * inverse) + 1;
            if (cellsX * cellsY * cellsZ <= maxCells) break;
            size *= 1.26;
        }

        this.minX = minX;
        this.minY = minY;
        this.minZ = minZ;
        this.inverseCellSize = 1 / size;
        this.cellsX = cellsX;
        this.cellsY = cellsY;
        this.cellsZ = cellsZ;
        const cellCount = cellsX * cellsY * cellsZ;

        // --- Make sure the reusable buffers are big enough ---
        if (this.cellStart.length < cellCount + 1) {
            this.cellStart = new Int32Array(cellCount + 1);
            this.cursor = new Int32Array(cellCount);
        }
        if (this.cellOfPoint.length < count) {
            // 50% headroom so we don't reallocate again for small increases.
            const capacity = Math.ceil(count * 1.5);
            this.cellOfPoint = new Int32Array(capacity);
            this.sortedIndices = new Int32Array(capacity);
        }

        const { cellStart, cursor, cellOfPoint, sortedIndices } = this;
        const inverse = this.inverseCellSize;
        const layerSize = cellsX * cellsY;

        // --- 3. Histogram: count the points in each cell ---
        // Counts are stored one slot ahead (at c + 1) so the next step can
        // turn them into start offsets in place.
        cellStart.fill(0, 0, cellCount + 1);
        for (let i = 0, i3 = 0; i < count; i++, i3 += 3) {
            const cx = Math.floor((positions[i3] - minX) * inverse);
            const cy = Math.floor((positions[i3 + 1] - minY) * inverse);
            const cz = Math.floor((positions[i3 + 2] - minZ) * inverse);
            const cell = cx + cy * cellsX + cz * layerSize;
            cellOfPoint[i] = cell;
            cellStart[cell + 1]++;
        }

        // --- 4. Prefix sum: cellStart[c] = number of points in cells before c ---
        for (let c = 0; c < cellCount; c++) {
            cellStart[c + 1] += cellStart[c];
        }

        // --- 5. Scatter: put each point's index into its cell's range ---
        // `cursor` tracks the next free slot in each cell.
        cursor.set(cellStart.subarray(0, cellCount));
        for (let i = 0; i < count; i++) {
            sortedIndices[cursor[cellOfPoint[i]]++] = i;
        }
    }

    /**
     * Reports every pair of points closer than `maxDistance`.
     * build() must have been called with the same `positions` first.
     *
     * Cell by cell, each point is compared with:
     *   - the points after it in its own cell, and
     *   - the points in the 13 "forward" neighbour cells (see HALF_SHELL).
     * so each pair is tested exactly once.
     *
     * @param {Float32Array} positions xyz per point
     * @param {number} maxDistance report pairs closer than this. It must not
     *        be larger than the `cellSize` given to build().
     * @param {(i: number, j: number, distanceSq: number) => void} onPair
     */
    forEachPair(positions, maxDistance, onPair) {
        const maxDistanceSq = maxDistance * maxDistance;
        const { cellStart, sortedIndices, neighbourCells } = this;
        const { cellsX, cellsY, cellsZ } = this;
        const layerSize = cellsX * cellsY;

        for (let cz = 0; cz < cellsZ; cz++) {
            for (let cy = 0; cy < cellsY; cy++) {
                for (let cx = 0; cx < cellsX; cx++) {
                    const cell = cx + cy * cellsX + cz * layerSize;
                    const start = cellStart[cell];
                    const end = cellStart[cell + 1];
                    if (start === end) continue; // empty cell

                    // Gather this cell's non-empty forward neighbours once, so
                    // the per-point loop below doesn't repeat bounds checks.
                    let neighbourCount = 0;
                    for (let n = 0; n < HALF_SHELL_COUNT; n++) {
                        const nx = cx + HALF_SHELL[n * 3];
                        const ny = cy + HALF_SHELL[n * 3 + 1];
                        const nz = cz + HALF_SHELL[n * 3 + 2];
                        // Skip neighbours that fall outside the grid
                        if (
                            nx < 0 ||
                            nx >= cellsX ||
                            ny < 0 ||
                            ny >= cellsY ||
                            nz >= cellsZ
                        ) {
                            continue;
                        }
                        const neighbour = nx + ny * cellsX + nz * layerSize;
                        if (cellStart[neighbour] !== cellStart[neighbour + 1]) {
                            neighbourCells[neighbourCount++] = neighbour;
                        }
                    }

                    for (let a = start; a < end; a++) {
                        const i = sortedIndices[a];
                        const i3 = i * 3;
                        const ix = positions[i3];
                        const iy = positions[i3 + 1];
                        const iz = positions[i3 + 2];

                        // Other points in the same cell: only those later in
                        // the list, so (i, j) is never also visited as (j, i).
                        for (let b = a + 1; b < end; b++) {
                            const j = sortedIndices[b];
                            const j3 = j * 3;
                            const dx = positions[j3] - ix;
                            const dy = positions[j3 + 1] - iy;
                            const dz = positions[j3 + 2] - iz;
                            const distanceSq = dx * dx + dy * dy + dz * dz;
                            if (distanceSq < maxDistanceSq) {
                                onPair(i, j, distanceSq);
                            }
                        }

                        // Points in the forward neighbour cells
                        for (let n = 0; n < neighbourCount; n++) {
                            const neighbour = neighbourCells[n];
                            const neighbourEnd = cellStart[neighbour + 1];
                            for (
                                let b = cellStart[neighbour];
                                b < neighbourEnd;
                                b++
                            ) {
                                const j = sortedIndices[b];
                                const j3 = j * 3;
                                const dx = positions[j3] - ix;
                                const dy = positions[j3 + 1] - iy;
                                const dz = positions[j3 + 2] - iz;
                                const distanceSq = dx * dx + dy * dy + dz * dz;
                                if (distanceSq < maxDistanceSq) {
                                    onPair(i, j, distanceSq);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
