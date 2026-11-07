/**
 * Configures troika once for every SDF text in the app (the perf HUD, the gallery plaques, the settings panel): the
 * local font and main-thread typesetting, which keeps troika off blob workers and its CDN. Troika
 * ignores, with a warning, a configureTextBuilder call made after the first font request, so every
 * text module imports this one before it creates any `Text`.
 */
import { configureTextBuilder } from 'troika-three-text';

export const TEXT_FONT_URL = `${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`;

configureTextBuilder({ defaultFontURL: TEXT_FONT_URL, useWorker: false });
