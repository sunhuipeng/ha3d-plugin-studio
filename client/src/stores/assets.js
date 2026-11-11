/* useAssetsStore —— 模型文件库 + 家具分类目录
 *
 * 这两块以前混在项目 store 里，其实服务的是完全不同的 UI（部件面板 / 家具编辑器），
 * 拆出来后各自的状态、加载与出错提示都在一个 store 内闭环，Action 可单独被 ws-client 调用。
 */
import { defineStore } from 'pinia';
import { api } from '../lib/api';
import { denyWhenLocked } from '../lib/guards';
import { bumpModel } from '../thumb';
import { FALLBACK_CATALOG_TYPES } from '../catalog';
import { useProjectStore } from './project';
import { useUiStore } from './ui';

export const useAssetsStore = defineStore('studio-assets', {
  state: () => ({
    models: [],            // 模型文件库（项目 models 目录全部 .glb）
    fixing: false,         // GLB 材质修复中
    /* 家具项目分类下拉：GET /catalog-types（studio 服务端优先向 ha-3d-home 的
     * /api/catalog 取，取不到才用本地兜底表）。source = 'home' | 'fallback' */
    catalogTypes: FALLBACK_CATALOG_TYPES.slice(),
    catalogTypesSource: '',
  }),

  getters: {
    modelCount: (s) => s.models.length,
    catalogHomeConnected: (s) => s.catalogTypesSource === 'home',
  },

  actions: {
    async loadModels() {
      const pid = useProjectStore().projectId;
      if (!pid) { this.models = []; return; }
      try { this.models = (await api('GET', `/api/projects/${pid}/models`)).files; }
      catch (e) { this.models = []; }
    },
    async importFile(file) {
      if (denyWhenLocked()) return;
      const pid = useProjectStore().projectId;
      if (!pid) return;
      const buf = await file.arrayBuffer();
      await api('PUT', `/api/projects/${pid}/models/${encodeURIComponent(file.name)}`, buf, true);
      await this.loadModels();
    },
    async importFiles(files) {
      const ui = useUiStore();
      let ok = 0;
      for (const f of files) {
        if (!f.name.toLowerCase().endsWith('.glb')) { ui.showToast('仅支持 .glb: ' + f.name, true); continue; }
        try { await this.importFile(f); ok += 1; }
        catch (e) { ui.showToast('导入失败: ' + f.name + ' ' + e.message, true); }
      }
      if (ok) ui.showToast(`已导入 ${ok} 个模型`);
    },
    async deleteModel(file) {
      if (denyWhenLocked()) return;
      const ui = useUiStore();
      const pid = useProjectStore().projectId;
      if (!pid) return;
      try { await api('DELETE', `/api/projects/${pid}/models/${encodeURIComponent(file)}`); }
      catch (e) { ui.showToast('删除失败: ' + e.message, true); }
      await this.loadModels();
      ui.showToast('已删除: ' + file);
    },
    /* 修复 GLB 材质过暗（metallic 偏高 / sRGB 未转换 / 压暗扩展） */
    async fixMaterial(file) {
      if (!useProjectStore().projectId || !file) return;
      const ui = useUiStore();
      this.fixing = true;
      try {
        const r = await api('POST', `/api/projects/${useProjectStore().projectId}/models/${encodeURIComponent(file)}/fix-materials`);
        ui.showToast(r.message);
        bumpModel(useProjectStore().projectId, file);   // 清缩略图缓存并刷新预览/画布
      } catch (e) {
        ui.showToast('修复失败: ' + e.message, true);
      } finally { this.fixing = false; }
    },
    /* 文件库中直接拆分多节点 GLB：服务端把每个 node 导出为独立 .glb 加入文件库 */
    async splitModelFile(file) {
      if (denyWhenLocked()) return;
      const ui = useUiStore();
      const pid = useProjectStore().projectId;
      if (!pid) return;
      try {
        const r = await api('POST', `/api/projects/${pid}/models/${encodeURIComponent(file)}/split`);
        await this.loadModels();
        ui.showToast(`已拆分「${file}」为 ${r.files.length} 个独立模型，已加入文件库（原文件保留；画布中引用原文件的部件不受影响）`);
      } catch (e) { ui.showToast('拆分失败: ' + e.message, true); }
    },
    /* 只把指定节点导出为一个独立 .glb（原文件不动，画布部件不受影响） */
    async splitModelNode(file, nodeName) {
      if (denyWhenLocked()) return;
      const ui = useUiStore();
      const pid = useProjectStore().projectId;
      if (!pid) return;
      try {
        const r = await api('POST', `/api/projects/${pid}/models/${encodeURIComponent(file)}/split`, { node: nodeName });
        await this.loadModels();
        ui.showToast(`已把节点「${r.node}」导出为 ${r.files[0].file}（原文件保留）`);
      } catch (e) { ui.showToast('拆分失败: ' + e.message, true); }
    },

    async loadCatalogTypes() {
      try {
        const d = await api('GET', '/api/catalog-types');
        if (Array.isArray(d.types) && d.types.length) {
          this.catalogTypes = d.types;
          this.catalogTypesSource = d.source || '';
        }
      } catch (e) { /* home 没连上也别拦着：用兜底表 */ }
    },
  },
});
