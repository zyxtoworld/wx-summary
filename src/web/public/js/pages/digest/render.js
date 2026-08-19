// Canvas 长图渲染:视觉全新设计;数据视图模型统一走 digest-view-model.js,
// 保证与 Markdown 导出/历史页完全一致的内容取舍。
import { digestRenderViewModel, normalizeDigestForRender } from '/js/shared/digest-view-model.js';
import {
  digestRenderPayload,
  DIGEST_RENDERER_ENGINE_BROWSER,
  DIGEST_RENDERER_VERSION,
  normalizeDigestAccentColor,
  normalizeDigestFontSize,
  resolveDigestTheme,
} from './render-selection.js';
export {
  DIGEST_RENDERER_ENGINE_BROWSER,
  DIGEST_RENDERER_VERSION,
} from './render-selection.js';
export {
  canvasToPngBlob,
  canvasToValidatedPngBytes,
  isPlausiblePng,
} from '/js/shared/canvas-png.js';

const CANVAS_WIDTH = 800; // CSS 像素,输出按 RENDER_SCALE 放大
const RENDER_SCALE = 2;

const PALETTES = Object.freeze({
  light: {
    page: '#eef0f4',
    card: '#ffffff',
    fg: '#1c2330',
    secondary: '#5b6472',
    muted: '#8a93a3',
    border: '#e7eaef',
    chipBg: 'rgba(7, 193, 96, 0.1)',
    quoteBg: '#f5f7f9',
    accentSoft: 'rgba(7, 193, 96, 0.14)',
  },
  dark: {
    page: '#101215',
    card: '#1b1e23',
    fg: '#e8eaf0',
    secondary: '#a9b0bd',
    muted: '#6f7684',
    border: '#2c3038',
    chipBg: 'rgba(7, 193, 96, 0.18)',
    quoteBg: '#22262c',
    accentSoft: 'rgba(7, 193, 96, 0.22)',
  },
});

function fontStack() {
  return '-apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
}

function font(size, weight = 400) {
  return `${weight} ${size}px ${fontStack()}`;
}

// 依据当前 ctx.font 做贪心换行,中英文混排按字符推进。
function wrapLines(ctx, text, maxWidth, maxLines = 0) {
  const lines = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = ch;
      if (maxLines && lines.length >= maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && (!maxLines || lines.length < maxLines)) lines.push(line);
  if (maxLines && lines.length > maxLines) lines.length = maxLines;
  if (maxLines && lines.length === maxLines) {
    const joined = lines.join('');
    const original = String(text || '').replace(/\n/g, '');
    if (joined.length < original.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/.$/u, '')}…`;
    }
  }
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// 两趟排版:第一趟量高度,第二趟真正绘制。
// 每个 section 提供 measure(ctx, width) 与 draw(ctx, x, y, width)。
export function renderDigestToCanvas(rawDigest, {
  theme = 'auto',
  fontSize = 'normal',
  font_size = '',
  accentColor = '',
  accent_color = '',
} = {}) {
  const renderPayload = digestRenderPayload({
    theme,
    fontSize: fontSize || font_size,
    accentColor: accentColor || accent_color,
  });
  const resolvedTheme = resolveDigestTheme(renderPayload.theme, () => renderPayload.theme);
  const palette = PALETTES[resolvedTheme] || PALETTES.light;
  const accent = normalizeDigestAccentColor(renderPayload.accent_color) || '#07c160';
  const large = normalizeDigestFontSize(renderPayload.font_size) === 'large';
  const base = large ? 17 : 15;
  const digest = normalizeDigestForRender(rawDigest);
  const view = digestRenderViewModel(digest);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const margin = 40;
  const contentWidth = CANVAS_WIDTH - margin * 2;
  const lineHeight = size => Math.round(size * 1.62);

  const sections = [];
  const gap = (height) => {
    sections.push({ measure: () => height, draw: () => {} });
  };

  const textBlock = ({ text, size, weight = 400, color, maxLines = 0, spacingAfter = 0, lineH = 0 }) => {
    const lh = lineH || lineHeight(size);
    let lines = [];
    sections.push({
      measure(c) {
        c.font = font(size, weight);
        lines = wrapLines(c, text, contentWidth, maxLines);
        return lines.length * lh + spacingAfter;
      },
      draw(c, x, y) {
        c.font = font(size, weight);
        c.fillStyle = color;
        c.textBaseline = 'top';
        lines.forEach((line, i) => c.fillText(line, x, y + i * lh));
      },
    });
  };

  const bulletBlock = (items, { size, color, bulletColor, maxLinesPerItem = 2 }) => {
    if (!items.length) return;
    const lh = lineHeight(size);
    const layouts = [];
    sections.push({
      measure(c) {
        c.font = font(size);
        layouts.length = 0;
        let height = 0;
        for (const item of items) {
          const lines = wrapLines(c, item, contentWidth - 22, maxLinesPerItem);
          layouts.push(lines);
          height += lines.length * lh + 8;
        }
        return height;
      },
      draw(c, x, y) {
        c.font = font(size);
        c.textBaseline = 'top';
        let cursor = y;
        for (const lines of layouts) {
          c.fillStyle = bulletColor;
          c.beginPath();
          c.arc(x + 5, cursor + Math.round(lh / 2) - 3, 3, 0, Math.PI * 2);
          c.fill();
          c.fillStyle = color;
          lines.forEach((line, i) => c.fillText(line, x + 22, cursor + i * lh));
          cursor += lines.length * lh + 8;
        }
      },
    });
  };

  const sectionTitle = label => {
    sections.push({
      measure: () => 34 + 14,
      draw(c, x, y) {
        c.font = font(base - 1, 650);
        const textWidth = c.measureText(label).width;
        const chipH = 26;
        const chipW = textWidth + 24;
        c.fillStyle = palette.chipBg;
        roundRectPath(c, x, y + 4, chipW, chipH, 13);
        c.fill();
        c.fillStyle = accent;
        c.textBaseline = 'top';
        c.fillText(label, x + 12, y + 8);
      },
    });
  };

  const divider = () => {
    sections.push({
      measure: () => 1 + 18,
      draw(c, x, y) {
        c.fillStyle = palette.border;
        c.fillRect(x, y, contentWidth, 1);
      },
    });
  };

  // ---- 头部 ----
  sections.push({
    measure: () => 6,
    draw(c, x, y) {
      c.fillStyle = accent;
      roundRectPath(c, margin, y, contentWidth, 6, 3);
      c.fill();
    },
  });
  gap(18);
  textBlock({
    text: digest.group || digest.group_name || '群聊摘要',
    size: large ? 27 : 24,
    weight: 700,
    color: palette.fg,
    maxLines: 2,
    spacingAfter: 6,
  });
  if (digest.headline) {
    textBlock({
      text: digest.headline,
      size: base + 1,
      weight: 550,
      color: palette.secondary,
      maxLines: 3,
      spacingAfter: 4,
    });
  }
  gap(6);
  for (const row of view.coverageRows) {
    textBlock({ text: row, size: base - 2.5, color: palette.muted, maxLines: 2, spacingAfter: 1 });
  }
  gap(16);

  // ---- 速览 ----
  const highlights = view.highlights.filter(item => item && item !== digest.headline);
  if (highlights.length) {
    sectionTitle('群聊速览');
    bulletBlock(highlights, { size: base, color: palette.fg, bulletColor: accent });
    gap(12);
  }

  // ---- 聊天主线 ----
  for (const section of view.topicSections) {
    sectionTitle(section.label || '聊天主线');
    section.topics.forEach((topic, index) => {
      textBlock({
        text: `${index + 1}. ${topic.title || `主题 ${index + 1}`}`,
        size: base + 1,
        weight: 650,
        color: palette.fg,
        maxLines: 2,
        spacingAfter: 2,
      });
      if (Array.isArray(topic.participants) && topic.participants.length) {
        textBlock({
          text: `参与:${topic.participants.join('、')}`,
          size: base - 2.5,
          color: palette.muted,
          maxLines: 1,
          spacingAfter: 2,
        });
      }
      if (topic.summary) {
        textBlock({
          text: topic.summary,
          size: base,
          color: palette.secondary,
          maxLines: 5,
          spacingAfter: 4,
        });
      }
      gap(4);
    });
    gap(10);
  }

  // ---- 链接资料 ----
  if (view.links.length) {
    sectionTitle('链接资料');
    const lh = lineHeight(base);
    const layouts = [];
    sections.push({
      measure(c) {
        layouts.length = 0;
        let height = 0;
        for (const link of view.links) {
          c.font = font(base, 600);
          const titleLines = wrapLines(c, link.title || link.url || '链接', contentWidth, 2);
          c.font = font(base - 2.5);
          const summaryLines = link.summary ? wrapLines(c, link.summary, contentWidth, 2) : [];
          layouts.push({ titleLines, summaryLines, url: link.url || '' });
          height += titleLines.length * lh + summaryLines.length * lineHeight(base - 2.5) + lineHeight(base - 2.5) + 12;
        }
        return height;
      },
      draw(c, x, y) {
        let cursor = y;
        c.textBaseline = 'top';
        for (const item of layouts) {
          c.font = font(base, 600);
          c.fillStyle = palette.fg;
          item.titleLines.forEach((line, i) => c.fillText(line, x, cursor + i * lh));
          cursor += item.titleLines.length * lh;
          if (item.summaryLines.length) {
            c.font = font(base - 2.5);
            c.fillStyle = palette.secondary;
            item.summaryLines.forEach((line, i) => c.fillText(line, x, cursor + i * lineHeight(base - 2.5)));
            cursor += item.summaryLines.length * lineHeight(base - 2.5);
          }
          if (item.url) {
            c.font = font(base - 2.5);
            c.fillStyle = accent;
            c.fillText(item.url, x, cursor);
            cursor += lineHeight(base - 2.5);
          }
          cursor += 12;
        }
      },
    });
    gap(10);
  }

  // ---- 群里金句 ----
  if (view.quotes.length) {
    sectionTitle('群里金句');
    const lh = lineHeight(base);
    const layouts = [];
    sections.push({
      measure(c) {
        layouts.length = 0;
        let height = 0;
        for (const quote of view.quotes) {
          const label = quote.speaker ? `${quote.speaker}:${quote.text}` : quote.text;
          c.font = font(base);
          const lines = wrapLines(c, label, contentWidth - 28, 3);
          layouts.push({ lines, context: quote.context || '' });
          height += lines.length * lh + 20 + 10;
        }
        return height;
      },
      draw(c, x, y) {
        let cursor = y;
        c.textBaseline = 'top';
        for (const item of layouts) {
          const boxH = item.lines.length * lh + 20;
          c.fillStyle = palette.quoteBg;
          roundRectPath(c, x, cursor, contentWidth, boxH, 10);
          c.fill();
          c.fillStyle = accent;
          c.fillRect(x, cursor, 3, boxH);
          c.font = font(base);
          c.fillStyle = palette.fg;
          item.lines.forEach((line, i) => c.fillText(line, x + 16, cursor + 10 + i * lh));
          cursor += boxH + 10;
        }
      },
    });
    gap(10);
  }

  // ---- 后续关注 ----
  if (view.todos.length) {
    sectionTitle('后续关注');
    bulletBlock(
      view.todos.map(todo => {
        const owner = todo.owner ? `${todo.owner}:` : '';
        const deadline = todo.deadline ? `(${todo.deadline})` : '';
        return `${owner}${todo.item}${deadline}`;
      }),
      { size: base, color: palette.fg, bulletColor: '#d9870d' },
    );
    gap(12);
  }

  // ---- 页脚 ----
  divider();
  const createdAt = digest.created_at || '';
  textBlock({
    text: `由「微信群总结」本地生成${createdAt ? ` · ${createdAt}` : ''}`,
    size: base - 3,
    color: palette.muted,
    maxLines: 1,
  });
  gap(8);

  // 第一趟:量高。
  canvas.width = CANVAS_WIDTH * RENDER_SCALE;
  let height = margin;
  for (const section of sections) height += section.measure(ctx);
  height += margin;

  // 第二趟:绘制。
  canvas.height = Math.max(1, Math.round(height * RENDER_SCALE));
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  ctx.fillStyle = palette.page;
  ctx.fillRect(0, 0, CANVAS_WIDTH, height);
  // 卡片底
  ctx.fillStyle = palette.card;
  roundRectPath(ctx, 12, 12, CANVAS_WIDTH - 24, height - 24, 20);
  ctx.fill();

  let y = margin;
  for (const section of sections) {
    const sectionHeight = section.measure(ctx);
    section.draw(ctx, margin, y);
    y += sectionHeight;
  }

  return {
    canvas,
    theme: resolvedTheme,
    fontSize: large ? 'large' : 'normal',
    accentColor: accent,
    rendererVersion: DIGEST_RENDERER_VERSION,
    rendererEngine: DIGEST_RENDERER_ENGINE_BROWSER,
    width: CANVAS_WIDTH * RENDER_SCALE,
    height: canvas.height,
    digest,
  };
}
