import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
/* 最早引入：把 three 拉到 r147 legacy 色彩/光照口径（后续模块里 new Color(...) 都受影响） */
import './engine/three-legacy';
import App from './App.vue';
import './style.css';
import { initRuntimeLog } from './runtime-log';
import { installUiGuards } from './stores';

/* 先挂运行期日志钩子，再挂载应用 —— 首屏渲染的报错也要能进缓冲 */
initRuntimeLog();

const app = createApp(App);
/* Pinia 必须在任何 useStore() 之前安装：App.vue 的 setup、ws-client 的事件回调都会读 Store */
app.use(createPinia());
app.use(ElementPlus, { locale: zhCn });
/* 全局预览高亮取消监听（幂等，只装一次） */
installUiGuards();
app.mount('#app');
