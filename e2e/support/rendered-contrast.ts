import { expect, type Locator } from '@playwright/test';

export async function renderedContrast(locator: Locator, outline = false) {
  return locator.evaluate((element, outline) => {
    type Color = [number, number, number, number];
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const color = (value: string): Color => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
    };
    const over = (front: Color, back: Color): Color => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      return [...front.slice(0, 3).map((v, i) => alpha ? (v * front[3] + back[i] * back[3] * (1 - front[3])) / alpha : 0), alpha] as Color;
    };
    const style = getComputedStyle(element);
    let foreground = color(outline ? style.outlineColor : style.color), background: Color = [0, 0, 0, 0];
    // Composite each opacity/filter group before painting its ancestor's layer.
    // Reject unsupported images/filters instead of pretending tokens are pixels.
    const filter = (c: Color, css: string): Color => {
      if (css === 'none') return c;
      const match = /^brightness\((\d*\.?\d+)(%)?\)$/.exec(css);
      if (!match) throw new Error('Unsupported contrast filter');
      const factor = Number(match[1]) / (match[2] ? 100 : 1);
      return [Math.min(255, c[0] * factor), Math.min(255, c[1] * factor), Math.min(255, c[2] * factor), c[3]];
    };
    if (outline) { foreground = filter(foreground, style.filter); foreground[3] *= Number(style.opacity); }
    for (let node = outline ? element.parentElement : element; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.backgroundImage !== 'none' && (foreground[3] < 1 || background[3] < 1)) throw new Error('Unsupported contrast background image');
      const layer = color(css.backgroundColor);
      foreground = filter(over(foreground, layer), css.filter);
      background = filter(over(background, layer), css.filter);
      foreground[3] *= Number(css.opacity); background[3] *= Number(css.opacity);
    }
    const white: Color = [255, 255, 255, 1]; foreground = over(foreground, white); background = over(background, white);
    const luminance = (c: Color) => c.slice(0, 3).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const a = luminance(foreground), b = luminance(background);
    return { foreground: foreground.slice(0, 3), background: background.slice(0, 3), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), cssColor: outline ? style.outlineColor : style.color, opacity: style.opacity, fontSize: style.fontSize, fontWeight: style.fontWeight, outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, focusVisible: element.matches(':focus-visible') };
  }, outline);
}
export async function assertContrast(locator: Locator, threshold: number, outline = false) {
  const result = await renderedContrast(locator, outline);
  expect(result.ratio).toBeGreaterThanOrEqual(threshold); // Never round before asserting.
  return result;
}
