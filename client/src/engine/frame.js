/* 包围盒取景数学（thumb.js 缩略图 与 ModelPreview.vue 大图预览 共用）
 *
 * 同一套公式、各自的构图系数：dist = (maxDim/2) / tan(fov/2) * padding，
 * 机位 = center + dist * dir。改构图只需调 padding / dir，不再两处手抄公式。 */
import * as THREE from 'three';

export function frameObject(box, { fov = 40, padding = 1.5, dir = { x: 0.65, y: 0.55, z: 0.65 } } = {}) {
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = (maxDim / 2) / Math.tan((fov * Math.PI / 180) / 2) * padding;
  const camPos = new THREE.Vector3(center.x + dist * dir.x, center.y + dist * dir.y, center.z + dist * dir.z);
  return { size, center, maxDim, dist, camPos };
}
