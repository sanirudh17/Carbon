# Monochrome Icon System Manifest (ADDENDUM v10.2)

## 1. Hierarchy & Token Rules
- **Monochrome Policy**: All glyphs render in `currentColor`. No colored dots, no colored type badges.
- **Tile Tokens (ADDENDUM v13 F2)**:
  - **Dark theme**: background `rgba(255, 255, 255, 0.07)` (hover `0.10`, selected `0.09`), zero border, glyph alpha `0.72`
  - **Light theme**: background `rgba(0, 0, 0, 0.06)` (hover `0.10`, selected `0.09`), zero border, glyph alpha `0.66`
  - **Tile geometry**: `36px` tile, `10px` border-radius (`--tile-radius: 10px`), zero border in any state
  - **Glyph ratio**: `20px` in `36px` tile (~55-60% of tile box)
- **Hierarchy by Stroke & Alpha**:
  - Primary UI / Navigation: `strokeWidth: 2` (or `2.25`), alpha `1.0`
  - Content Rows & Lists: `strokeWidth: 1.8` (or `1.75`), alpha `0.72` (dark) / `0.66` (light)
  - Micro / Inline hints: `strokeWidth: 2.0`, size `13-14px`, alpha `0.55`
- **Accent Isolation**: Accent color (`var(--accent)`) applies strictly to selection rings, keyboard focus rings, and active tab highlights — NEVER to glyph paths or tile backgrounds.

---

## 2. Icon Registry Manifest

| Usage Key | Category | Glyph ID (Lucide) | Candidate (Huge) | Candidate (Phosphor) | Source URL | Size(s) | Stroke / Weight |
|:---|:---|:---|:---|:---|:---|:---|:---|
| `content-text` | Content Types | `Type` | `Text` | `TextT` | https://lucide.dev/icons/type | 16, 20px | 1.8 |
| `content-code` | Content Types | `Code` | `Code` | `Code` | https://lucide.dev/icons/code | 16, 20px | 1.8 |
| `content-rich` | Content Types | `FileText` | `FileDocument` | `Article` | https://lucide.dev/icons/file-text | 16, 20px | 1.8 |
| `content-image` | Content Types | `Image` | `Image01` | `Image` | https://lucide.dev/icons/image | 16, 20px | 1.8 |
| `content-file` | Content Types | `File` | `File01` | `File` | https://lucide.dev/icons/file | 16, 20px | 1.8 |
| `content-link` | Content Types | `Link` | `Link01` | `Link` | https://lucide.dev/icons/link | 16, 20px | 1.8 |
| `content-email` | Content Types | `Mail` | `Mail01` | `EnvelopeSimple` | https://lucide.dev/icons/mail | 16, 20px | 1.8 |
| `content-color` | Content Types | `Palette` | `PaintBoard` | `Palette` | https://lucide.dev/icons/palette | 16, 20px | 1.8 |
| `content-video` | Content Types | `Video` | `Video01` | `VideoCamera` | https://lucide.dev/icons/video | 16, 20px | 1.8 |
| `ui-search` | Navigation | `Search` | `Search01` | `MagnifyingGlass` | https://lucide.dev/icons/search | 14, 16px | 1.8 |
| `ui-all` | Navigation | `Clock` | `Clock01` | `Clock` | https://lucide.dev/icons/clock | 16, 20px | 1.8 |
| `ui-favorite` | Actions | `Star` | `Star` | `Star` | https://lucide.dev/icons/star | 14, 16px | 1.8 |
| `ui-pin` | Actions | `Pin` | `Pin` | `PushPin` | https://lucide.dev/icons/pin | 14, 16px | 1.8 |
| `ui-copy` | Actions | `Copy` | `Copy01` | `Copy` | https://lucide.dev/icons/copy | 14, 16px | 1.8 |
| `ui-paste` | Actions | `ClipboardPaste` | `Clipboard` | `ClipboardText` | https://lucide.dev/icons/clipboard-paste | 14, 16px | 1.8 |
| `ui-delete` | Actions | `Trash2` | `Delete02` | `Trash` | https://lucide.dev/icons/trash-2 | 14, 16px | 1.8 |
| `ui-settings` | Navigation | `Settings` | `Settings01` | `Gear` | https://lucide.dev/icons/settings | 16, 20px | 1.8 |
| `ui-folder` | Collections | `Folder` | `Folder01` | `Folder` | https://lucide.dev/icons/folder | 15, 16px | 1.8 |
| `ui-lock` | Collections | `Lock` | `Lock` | `Lock` | https://lucide.dev/icons/lock | 14, 15px | 2.0 |
| `ui-unlock` | Collections | `Unlock` | `LockUnlocked01` | `LockOpen` | https://lucide.dev/icons/unlock | 14, 15px | 2.0 |
| `ui-eye` | Privacy | `Eye` | `View` | `Eye` | https://lucide.dev/icons/eye | 14px | 2.0 |
| `ui-eye-off` | Privacy | `EyeOff` | `ViewOff` | `EyeSlash` | https://lucide.dev/icons/eye-off | 14px | 2.0 |
| `ui-queue` | Queue | `ListOrdered` | `Queue01` | `Queue` | https://lucide.dev/icons/list-ordered | 14px | 2.0 |
| `ui-drag` | Queue | `GripVertical` | `DragDropVertical` | `DotsSixVertical` | https://lucide.dev/icons/grip-vertical | 10, 14px | 2.0 |
| `ui-plus` | Actions | `Plus` | `PlusSign` | `Plus` | https://lucide.dev/icons/plus | 13, 16px | 2.2 |
| `ui-edit` | Actions | `Pencil` | `PencilEdit02` | `PencilSimple` | https://lucide.dev/icons/pencil | 14, 16px | 2.0 |
| `ui-more` | Actions | `MoreHorizontal` | `MoreHorizontal` | `DotsThree` | https://lucide.dev/icons/more-horizontal | 14, 16px | 2.0 |
| `ui-chevron-right` | Navigation | `ChevronRight` | `ArrowRight01` | `CaretRight` | https://lucide.dev/icons/chevron-right | 14, 16px | 1.8 |
| `ui-chevron-left` | Navigation | `ChevronLeft` | `ArrowLeft01` | `CaretLeft` | https://lucide.dev/icons/chevron-left | 14, 16px | 1.8 |
| `ui-chevron-down` | Navigation | `ChevronDown` | `ArrowDown01` | `CaretDown` | https://lucide.dev/icons/chevron-down | 14, 16px | 2.0 |
| `ui-check` | Feedback | `Check` | `Checkmark` | `Check` | https://lucide.dev/icons/check | 13, 16px | 2.4 |
| `ui-sun-moon` | Theme | `SunMoon` | `Sun01` | `SunDim` | https://lucide.dev/icons/sun-moon | 16, 20px | 1.8 |
| `ui-alert` | Feedback | `AlertTriangle` | `Alert02` | `Warning` | https://lucide.dev/icons/alert-triangle | 16, 20px | 2.0 |
| `ui-ocr` | Actions | `ScanText` | `TextRecognition` | `Scan` | https://lucide.dev/icons/scan-text | 16, 18px | 1.8 |
| `snippet-scissors`| Snippets | `Scissors` | `Scissor` | `Scissors` | https://lucide.dev/icons/scissors | 14, 16px | 1.8 |
| `snippet-calendar`| Snippets | `Calendar` | `Calendar01` | `Calendar` | https://lucide.dev/icons/calendar | 14, 16px | 1.8 |
| `snippet-at` | Snippets | `AtSign` | `At` | `At` | https://lucide.dev/icons/at-sign | 14, 16px | 1.8 |
| `snippet-hashtag` | Snippets | `Hash` | `Tag01` | `Hash` | https://lucide.dev/icons/hash | 14, 16px | 1.8 |
| `snippet-bolt` | Snippets | `Zap` | `Flash` | `Lightning` | https://lucide.dev/icons/zap | 14, 16px | 1.8 |
| `snippet-quote` | Snippets | `Quote` | `QuoteUp` | `Quotes` | https://lucide.dev/icons/quote | 14, 16px | 1.8 |
| `snippet-key` | Snippets | `Key` | `Key01` | `Key` | https://lucide.dev/icons/key | 14, 16px | 1.8 |
| `snippet-gear` | Snippets | `Sliders` | `SettingConfig` | `Sliders` | https://lucide.dev/icons/sliders | 14, 16px | 1.8 |
| `brand-carbon` | Brand | `CarbonMark` | N/A | N/A | Local SVG | 24px | 2.0 |
| `brand-badge` | Brand | `BrandBadge` | N/A | N/A | Local PNG (multi-res) | 32, 64px | N/A |
