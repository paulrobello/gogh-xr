// troika-three-text 0.52.5 ships no type declarations; this covers the parts the app uses.
declare module 'troika-three-text' {
  import type { Color, Mesh } from 'three';

  export class Text extends Mesh {
    constructor();
    text: string;
    readonly textRenderInfo: { blockBounds: [number, number, number, number] } | null;
    font: string | null;
    fontSize: number;
    maxWidth: number;
    anchorX: number | string;
    anchorY: number | string;
    textAlign: string;
    whiteSpace: string;
    lineHeight: number | string;
    color: number | string | Color;
    sync(callback?: () => void): void;
    dispose(): void;
  }

  export function configureTextBuilder(config: {
    defaultFontURL?: string;
    useWorker?: boolean;
  }): void;
}
