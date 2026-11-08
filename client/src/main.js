import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
/* 最早引入：把 three 拉到 r147 legacy 色彩/光照口径（后续模块里 new Color(...) 都受影响） */
import './engine/three-legacy';
import App from './App.vue';
import './style.css';
import { initRuntimeLog } from './runtime-log';

/* 先挂运行期日志钩子，再挂载应用 —— 首屏渲染的报错也要能进缓冲 */
initRuntimeLog();

createApp(App).use(ElementPlus, { locale: zhCn }).mount('#app');
