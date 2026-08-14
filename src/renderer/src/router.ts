import { createRouter, createWebHashHistory } from 'vue-router'
import DashboardView from './views/DashboardView.vue'
import PositionView from './views/PositionView.vue'
import NewsView from './views/NewsView.vue'
import SettingsView from './views/SettingsView.vue'

// hash 路由（file:// 协议下也必须用 hash，electron 打包后加载本地文件）
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/fund/:code', name: 'fund-detail', component: () => import('./views/FundDetailView.vue') },
    { path: '/position', name: 'position', component: PositionView },
    { path: '/news', name: 'news', component: NewsView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
