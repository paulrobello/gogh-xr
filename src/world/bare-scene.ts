import { Color, GridHelper, Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';

export const PLACEHOLDER_SKY = 0x1b2a55;

export function createBareScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(PLACEHOLDER_SKY);
  const ground = new Mesh(new PlaneGeometry(200, 200), new MeshBasicMaterial({ color: 0x2b3a2b }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new GridHelper(200, 100, 0x4a5f4a, 0x3a4c3a));
  return scene;
}
