
/**
 * CanvasPool: A singleton utility to reuse canvas elements.
 * This prevents frequent allocation and deallocation of canvas objects,
 * which reduces garbage collection pressure during batch processing.
 */
class CanvasPool {
  private pool: HTMLCanvasElement[] = [];

  /**
   * Acquires a canvas from the pool or creates a new one.
   * Automatically sets the requested dimensions.
   */
  acquire(width: number, height: number): HTMLCanvasElement {
    const canvas = this.pool.pop() || document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Returns a canvas to the pool for later reuse.
   */
  release(canvas: HTMLCanvasElement): void {
    // Clear the canvas to free up memory internal to the canvas if possible
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    // Reset dimensions to minimum to reduce idle memory usage
    canvas.width = 0;
    canvas.height = 0;
    this.pool.push(canvas);
  }
}

export const canvasPool = new CanvasPool();
