import {
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three';
import { Text } from 'troika-three-text';
import type { PainterSpotDisplay } from '../paintings/find-painter-spot';
import { PANEL_COLORS } from './settings-panel-colors';
import { TEXT_FONT_URL } from './troika-config';

const ORDER = 1_000_020;
const WIDTH = 0.32;
const IMAGE_WIDTH = 0.23;
const IMAGE_HEIGHT = IMAGE_WIDTH * (811 / 1024);

export interface PainterSpotHud {
  show(display: PainterSpotDisplay | null): void;
  diag(): { text: string; reference: boolean } | null;
  dispose(): void;
}

export function createPainterSpotHud(camera: Object3D, referenceUrl: string): PainterSpotHud {
  const panel = new Group();
  panel.name = 'painter-spot-hud';
  // Above the view centre, clear of the performance HUD below it.
  panel.position.set(0, 0.33, -0.75);
  panel.visible = false;

  const quad = new PlaneGeometry(1, 1);
  const overlay = { transparent: true, depthTest: false, depthWrite: false };
  const backing = new MeshBasicMaterial({ ...overlay, color: PANEL_COLORS.backing, opacity: 0.9 });
  const plate = new Mesh(quad, backing);
  plate.renderOrder = ORDER;
  plate.frustumCulled = false;
  const art = new MeshBasicMaterial({ ...overlay, toneMapped: false });
  const image = new Mesh(quad, art);
  image.scale.set(IMAGE_WIDTH, IMAGE_HEIGHT, 1);
  image.position.y = -0.01 - IMAGE_HEIGHT / 2;
  image.renderOrder = ORDER + 1;
  image.frustumCulled = false;
  image.visible = false;

  const textMaterial = new MeshBasicMaterial(overlay);
  const text = new Text();
  text.font = TEXT_FONT_URL;
  text.fontSize = 0.015;
  text.color = PANEL_COLORS.title;
  text.textAlign = 'center';
  text.lineHeight = 1.2;
  text.anchorX = 'center';
  text.anchorY = 'middle';
  text.material = textMaterial;
  text.renderOrder = ORDER + 2;
  text.frustumCulled = false;
  panel.add(plate, image, text);
  camera.add(panel);

  let reference: Texture | null = null;
  let disposed = false;
  let current: PainterSpotDisplay | null = null;
  let failed = false;
  function paint(): void {
    panel.visible = current !== null;
    if (!current) return;
    image.visible = current.reference && art.map !== null;
    const imageSpace = image.visible ? IMAGE_HEIGHT + 0.01 : 0;
    const labelHeight = current.reference ? (failed ? 0.071 : 0.052) : 0.042;
    const height = imageSpace + labelHeight;
    plate.scale.set(WIDTH, height, 1);
    plate.position.y = -height / 2;
    text.position.y = -(imageSpace + height) / 2;
    const label =
      current.reference && failed ? `${current.text}\nReference image unavailable` : current.text;
    if (text.text !== label) {
      text.text = label;
      text.sync();
    }
  }

  return {
    show(display) {
      if (display === current) return;
      current = display;
      if (display?.reference && !reference) {
        const texture = new TextureLoader().load(
          referenceUrl,
          (loaded) => {
            if (disposed) return;
            art.map = loaded;
            art.needsUpdate = true;
            paint();
          },
          undefined,
          () => {
            if (disposed) return;
            failed = true;
            paint();
          },
        );
        texture.colorSpace = SRGBColorSpace;
        reference = texture;
      }
      paint();
    },
    diag: () => current && { text: text.text, reference: image.visible },
    dispose() {
      disposed = true;
      panel.removeFromParent();
      text.dispose();
      textMaterial.dispose();
      backing.dispose();
      art.dispose();
      reference?.dispose();
      quad.dispose();
    },
  };
}
