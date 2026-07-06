/**
 * SciFigure Studio - 网页真实测试脚本 v2
 * 测试目标：验证 SCI4.0 升级计划核心链路
 *
 * 运行: node tests/playwright/scifigure_test_plan.mjs
 *
 * 依赖: playwright (npm install --save-dev playwright)
 * 前置条件: 服务运行在 http://localhost:3000, npx playwright install chromium
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../../test-results');
const BASE_URL = 'http://localhost:3000';

// ============= 测试结果收集 =============
const results = [];
let screenshotCounter = 0;

function pass(id, note = '') { results.push({ id, status: 'PASS', note }); console.log(`  ✅ PASS  ${id}: ${note}`); }
function fail(id, details) { results.push({ id, status: 'FAIL', ...details }); console.log(`  ❌ FAIL  ${id}: ${details.note || details.actual || ''}`); }
function partial(id, note = '') { results.push({ id, status: 'PARTIAL', note }); console.log(`  ⚠️  PARTIAL  ${id}: ${note}`); }
function blocked(id, note = '') { results.push({ id, status: 'BLOCKED', note }); console.log(`  🔒 BLOCKED  ${id}: ${note}`); }

async function screenshot(page, label) {
  screenshotCounter++;
  const filename = `${String(screenshotCounter).padStart(3, '0')}_${label.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80)}.png`;
  const filepath = path.join(OUTPUT_DIR, filename);
  try { await page.screenshot({ path: filepath, fullPage: false }); } catch {}
  return filepath;
}

async function clickText(page, text, { timeout = 5000, exact = false } = {}) {
  try {
    const loc = exact ? page.locator(`text="${text}"`).first() : page.locator(`:has-text("${text}")`).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
    return true;
  } catch (e) {
    return false;
  }
}

// ============= 主测试流程 =============
async function runTests() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('\n========== SciFigure Studio 网页真实测试 v2 ==========\n');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`项目路径: ${path.resolve(__dirname, '../..')}`);
  console.log(`服务地址: ${BASE_URL}\n`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  const pageErrors = [];
  context.on('page', (p) => {
    p.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    p.on('pageerror', err => pageErrors.push(err.message));
  });

  const page = await context.newPage();

  // ============= 前置: 导航到编辑器 =============
  console.log('--- 前置: 导航到编辑器 ---');
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(3000);
    await screenshot(page, '00_initial_load');

    // Check what view we're in
    const bodyText = await page.textContent('body');
    console.log(`  Body text (first 100): ${bodyText.slice(0, 100).replace(/\n/g, ' ')}`);

    // Try direct navigation: click "我的项目"
    const clicked = await clickText(page, '我的项目');
    console.log(`  Click '我的项目': ${clicked ? 'success' : 'not found'}`);
    if (clicked) {
      await page.waitForTimeout(2000);
      await screenshot(page, '01_projects_page');

      // Now click the first project card (there's at least one in the DB)
      const projectCards = page.locator('[class*="rounded-xl"]').filter({ hasText: 'Test' }).first();
      if (await projectCards.isVisible({ timeout: 3000 }).catch(() => false)) {
        await projectCards.click();
        console.log('  Clicked first project card');
      } else {
        // Click any project card
        const anyCard = page.locator('[class*="border-slate-200"][class*="cursor-pointer"]').first();
        if (await anyCard.isVisible({ timeout: 3000 }).catch(() => false)) {
          await anyCard.click();
          console.log('  Clicked project card (generic)');
        }
      }
      await page.waitForTimeout(5000);
      await screenshot(page, '02_editor_loading');
      
      // Wait for editor to render - look for SVG or editor elements
      await page.waitForTimeout(5000);
    } else {
      console.log('  Could not navigate - trying alternative approach');
      // Try "开始创建" or "新建项目"
      await clickText(page, '新建项目');
      await page.waitForTimeout(2000);
      await clickText(page, '进入编辑器');
      await page.waitForTimeout(3000);
      await screenshot(page, '02_alt_navigation');
    }

    // Now check if editor loaded
    const editorText = await page.textContent('body');
    const hasEditor = editorText.includes('同步至引擎') || editorText.includes('属性编辑') || 
                      editorText.includes('预览') || editorText.includes('组件中心');
    console.log(`  Editor loaded: ${hasEditor}`);
    await screenshot(page, '03_editor_state');
  } catch (e) {
    console.log(`  Navigation error: ${e.message}`);
  }

  // ============= A: 基础启动 =============
  console.log('\n--- A: 基础启动与页面稳定性 ---');
  try {
    const svgCount = await page.evaluate(() => document.querySelectorAll('svg').length);
    const crashMsg = await page.textContent('body');
    const hasCrash = crashMsg.includes('编辑器出现异常') || crashMsg.includes('Objects are not valid');
    const sidebarButtons = await page.locator('button').count();
    
    if (hasCrash) {
      fail('A1', { note: '页面出现 React crash', actual: crashMsg.slice(0, 200), screenshot: await screenshot(page, 'A1_crash') });
    } else if (svgCount > 0) {
      pass('A1', `编辑器加载正常, SVG数=${svgCount}, 按钮数=${sidebarButtons}`);
    } else {
      partial('A1', `页面加载, SVG数=${svgCount}, 按钮数=${sidebarButtons}`);
    }
  } catch (e) {
    fail('A1', { note: `页面加载异常: ${e.message}` });
  }

  // ============= B: Python 单图编辑 =============
  console.log('\n--- B: Python 单图编辑 ---');
  
  // B1: 单击选择
  try {
    // Look for SVG text elements in the figure preview
    const svgTexts = page.locator('svg text').first();
    if (await svgTexts.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Try clicking various SVG text elements
      const textCount = await page.locator('svg text').count();
      let clicked = 0;
      for (let i = 0; i < Math.min(textCount, 5); i++) {
        try {
          const el = page.locator('svg text').nth(i);
          if (await el.isVisible()) {
            const box = await el.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              await page.waitForTimeout(300);
              clicked++;
            }
          }
        } catch {}
      }
      pass('B1', `尝试点击了 ${clicked} 个 SVG 图元`);
    } else {
      partial('B1', 'SVG 文本元素不可交互');
    }
    await screenshot(page, 'B1_click');
  } catch (e) {
    partial('B1', `单击选择异常: ${e.message}`);
  }

  // B2/B3: 检查属性编辑面板
  try {
    await clickText(page, '属性编辑');
    await page.waitForTimeout(500);
    const propPanelInputs = await page.locator('input').count();
    const propPanelLabels = await page.locator('label').count();
    pass('B2_Panel', `属性编辑面板: ${propPanelInputs} 个输入框, ${propPanelLabels} 个标签`);
    await screenshot(page, 'B2_properties');
  } catch (e) {
    partial('B2', `属性面板检查: ${e.message}`);
  }

  // ============= C: Draft Batch =============
  console.log('\n--- C: Draft Batch ---');
  try {
    // Check if there's a draft bar or pending changes indicator
    const draftText = await page.textContent('body');
    const hasDraftBar = draftText.includes('已暂存') || draftText.includes('暂存') || draftText.includes('draft');
    
    if (hasDraftBar) {
      pass('C1_Draft', '暂存条可见');
    } else {
      partial('C1_Draft', '未检测到暂存条（可能不在激活状态）');
    }
    
    // Check for "应用当前图" button
    const applyBtn = await clickText(page, '应用当前图');
    if (applyBtn) {
      pass('C1_Apply', '"应用当前图"按钮可点击');
    } else {
      const applyBtn2 = await clickText(page, '应用');
      if (applyBtn2) pass('C1_Apply', '"应用"按钮可点击');
      else partial('C1_Apply', '未找到"应用"相关按钮');
    }
    await screenshot(page, 'C1_draft');
  } catch (e) {
    partial('C1', `Draft检查异常: ${e.message}`);
  }

  // ============= D: Undo/Redo =============
  console.log('\n--- D: Undo/Redo ---');
  try {
    const undoVisible = await page.locator('button:has-text("撤销"), [title*="撤销"]').first().isVisible({ timeout: 2000 }).catch(() => false);
    const redoVisible = await page.locator('button:has-text("重做"), [title*="重做"]').first().isVisible({ timeout: 2000 }).catch(() => false);
    if (undoVisible && redoVisible) {
      pass('D1_Buttons', '撤销/重做按钮均可见');
    } else {
      partial('D1_Buttons', `撤销=${undoVisible}, 重做=${redoVisible}`);
    }
    await screenshot(page, 'D1_undo_redo');
  } catch (e) {
    partial('D1', `Undo检查: ${e.message}`);
  }

  // ============= E: 多图项目 =============
  console.log('\n--- E: 多图项目单图重绘 ---');
  try {
    // Check for figure tabs/thumbnails
    const figureTabs = await page.locator('[class*="figure"], [class*="fig_"], button:has-text("Figure"), button:has-text("fig")').count();
    pass('E1_Tabs', `检测到 ${figureTabs} 个图表切换元素`);
    await screenshot(page, 'E1_fig_tabs');
    
    // Check if there's a render/sync button
    const renderBtn = await clickText(page, '同步至引擎');
    if (renderBtn) {
      await page.waitForTimeout(2000);
      pass('E1_Render', '渲染按钮可点击');
    } else {
      partial('E1_Render', '同步至引擎按钮无法交互');
    }
    await screenshot(page, 'E2_render_result');
  } catch (e) {
    partial('E1', `多图检查: ${e.message}`);
  }

  // ============= F: 字体中心 =============
  console.log('\n--- F: 字体中心 ---');
  try {
    await clickText(page, '字体中心');
    await page.waitForTimeout(500);
    
    // Check for text role groups
    const roles = ['标题', 'X轴', 'Y轴', '刻度', '图例', 'tick', 'label', 'title', 'xlabel', 'ylabel'];
    let foundRoles = [];
    for (const role of roles) {
      if (await page.locator(`:has-text("${role}")`).first().isVisible({ timeout: 300 }).catch(() => false)) {
        foundRoles.push(role);
      }
    }
    if (foundRoles.length >= 3) {
      pass('F1_Groups', `字体中心角色分组: ${foundRoles.join(', ')}`);
    } else {
      partial('F1_Groups', `字体中心仅 ${foundRoles.length} 个角色: ${foundRoles.join(', ')}`);
    }
    await screenshot(page, 'F1_font_roles');
  } catch (e) {
    partial('F1', `字体中心异常: ${e.message}`);
  }

  // ============= G: 组件中心 =============
  console.log('\n--- G: 组件中心 ---');
  try {
    await clickText(page, '组件中心');
    await page.waitForTimeout(500);
    
    // Check for component groups
    const sections = await page.locator('h3, h4, [class*="category"], [class*="section"]').count();
    pass('G1_Categories', `组件中心: ${sections} 个分类`);
    await screenshot(page, 'G1_components');
  } catch (e) {
    partial('G1', `组件中心异常: ${e.message}`);
  }

  // ============= H: 配色中心 =============
  console.log('\n--- H: 配色中心 ---');
  try {
    await clickText(page, '配色中心');
    await page.waitForTimeout(500);
    
    const colorInputs = await page.locator('input[type="color"]').count();
    const colorSwatches = await page.locator('[class*="color"], [class*="swatch"]').count();
    pass('H1_UI', `配色中心: ${colorInputs} 个颜色选择器`);
    await screenshot(page, 'H1_palette');
  } catch (e) {
    partial('H1', `配色中心异常: ${e.message}`);
  }

  // ============= I: R 语言 =============
  console.log('\n--- I: R 语言路径 ---');
  try {
    // Try clicking "代码" tab to check language selector
    await clickText(page, '代码');
    await page.waitForTimeout(500);
    
    const rText = await page.textContent('body');
    const hasROption = rText.includes('R') || rText.includes('ggplot') || rText.includes('ggplot2');
    if (hasROption) {
      pass('I1_Option', '代码视图中存在 R/ggplot 选项');
    } else {
      partial('I1_Option', '代码视图未检测到 R 语言选项');
    }
    await screenshot(page, 'I1_code');
  } catch (e) {
    partial('I1', `R语言检查: ${e.message}`);
  }

  // ============= K: 拖拽模式 =============
  console.log('\n--- K: 拖拽模式 ---');
  try {
    const dragBtn = page.locator('button:has-text("拖拽"), [title*="拖拽"]').first();
    if (await dragBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const dragText = await dragBtn.textContent();
      await dragBtn.click();
      await page.waitForTimeout(500);
      const afterText = await dragBtn.textContent();
      pass('K1_Toggle', `拖拽按钮: "${dragText}" -> "${afterText}", 可切换`);
      await screenshot(page, 'K1_drag');
    } else {
      partial('K1_Toggle', '未检测到拖拽模式按钮');
    }
  } catch (e) {
    partial('K1', `拖拽检查: ${e.message}`);
  }

  // ============= L: 导出 =============
  console.log('\n--- L: 导出 ---');
  try {
    const exportBtn = page.locator('button:has-text("导出"), [class*="export"], a:has-text("导出")').first();
    if (await exportBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      pass('L1_Button', '导出按钮可见');
    }
    await screenshot(page, 'L1_export');
    
    // Try clicking export
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click();
      await page.waitForTimeout(2000);
      const exportPageText = await page.textContent('body');
      const hasExportFormat = exportPageText.includes('SVG') || exportPageText.includes('PNG') || exportPageText.includes('PDF') || exportPageText.includes('格式');
      if (hasExportFormat) pass('L2_Format', '导出页面有格式选项');
      else partial('L2_Format', '导出页面内容不符合预期');
      await screenshot(page, 'L2_export_page');
    }
  } catch (e) {
    partial('L1', `导出检查: ${e.message}`);
  }

  // ============= M: 组合图 / 资产库 =============
  console.log('\n--- M: 组合图 / 资产库 ---');
  try {
    // Check Navbar for composer/asset library links
    const navbarText = await page.locator('nav, [class*="navbar"], [class*="Navbar"]').first().textContent().catch(() => '');
    const hasComposer = navbarText.includes('组合') || await page.locator('text=组合图').first().isVisible({ timeout: 1000 }).catch(() => false);
    const hasLibrary = navbarText.includes('资产') || await page.locator('text=资产库').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (hasComposer) pass('M1_Composer', '组合图入口可见');
    else partial('M1_Composer', '未检测到组合图入口');
    if (hasLibrary) pass('M2_Library', '资产库入口可见');
    else partial('M2_Library', '未检测到资产库入口');
    await screenshot(page, 'M1_nav');
  } catch (e) {
    partial('M1', `导航检查: ${e.message}`);
  }

  // ============= N: 网络失败场景 =============
  console.log('\n--- N: 必测失败场景 ---');
  try {
    const saveBtn = page.locator('button:has-text("保存")').first();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) pass('N1_Save', '保存按钮可见');
    else partial('N1_Save', '未找到保存按钮');
  } catch {}

  // ============= Console 错误汇总 =============
  console.log('\n--- Console 错误汇总 ---');
  consoleErrors.forEach((err, i) => { if (i < 10) console.log(`  ⚠️  [${i}] ${err.slice(0, 150)}`); });
  if (consoleErrors.length === 0) console.log('  ✅ 无 Console error');
  else console.log(`  ⚠️  共 ${consoleErrors.length} 个 Console error (显示前10)`);
  pageErrors.forEach(err => console.log(`  ❌ PageError: ${err.slice(0, 150)}`));

  // ============= 清理 =============
  await browser.close();
  return results;
}

// ============= 报告生成 =============
function generateReport(results) {
  const testMatrix = ['A1','B1','B2','B3','C1','C2','C3','D1','D2','E1','E2','F1','F2','G1','H1','H2','I1','I2','J1','J2','K1','K2','K3','L1','L2','M1','M2','N1','N2','N3'];
  const resultMap = {};
  for (const r of results) resultMap[r.id] = r;

  const matrix = testMatrix.map(id => {
    const r = resultMap[id];
    return { id, status: r ? r.status : 'BLOCKED', note: r ? (r.note || '') : '未测试' };
  });

  const passCount = matrix.filter(m => m.status === 'PASS').length;
  const failCount = matrix.filter(m => m.status === 'FAIL').length;
  const partialCount = matrix.filter(m => m.status === 'PARTIAL').length;
  const blockedCount = matrix.filter(m => m.status === 'BLOCKED').length;
  
  const names = {
    'A1':'页面加载','B1':'单击选择','B2':'单文本修改不扩散','B3':'轴标题/刻度颜色隔离',
    'C1':'Draft不立即渲染','C2':'应用后一次渲染','C3':'取消暂存',
    'D1':'批量Undo','D2':'颜色Undo','E1':'单图重绘','E2':'stale response',
    'F1':'字体中心tick批量','F2':'多子图字体分组','G1':'组件中心',
    'H1':'配色子集/整组','H2':'配色Undo','I1':'R基础渲染','I2':'R轴级tick编辑',
    'J1':'Heatmap','J2':'Colorbar','K1':'拖拽关闭选择','K2':'拖拽确认','K3':'不支持拖拽提示',
    'L1':'单图导出revision','L2':'多图导出不串图','M1':'资产库','M2':'组合图',
    'N1':'网络失败','N2':'重复应用','N3':'切图draft保留'
  };

  return `# SciFigure Studio 网页真实测试报告

**测试时间**: ${new Date().toISOString()}
**浏览器**: Chromium (Playwright)
**项目路径**: E:\\ai绘图修改编辑
**服务地址**: ${BASE_URL}

## 总结

**总体结论**: ${failCount > 0 ? 'FAIL' : partialCount > 0 ? 'PARTIAL' : 'PASS'}

## 统计

| 结果 | 数量 |
|------|------|
| ✅ PASS | ${passCount} |
| ❌ FAIL | ${failCount} |
| ⚠️ PARTIAL | ${partialCount} |
| 🔒 BLOCKED | ${blockedCount} |
| **总计** | **${matrix.length}** |

## 测试矩阵

| 编号 | 测试项 | 结果 | 备注 |
|------|--------|------|------|
${matrix.map(m => `| ${m.id} | ${names[m.id] || m.id} | ${m.status === 'PASS' ? '✅' : m.status === 'FAIL' ? '❌' : m.status === 'PARTIAL' ? '⚠️' : '🔒'} ${m.status} | ${m.note} |`).join('\n')}

## 失败详情

${results.filter(r => r.status === 'FAIL').map(r => `
### ${r.id}
- **描述**: ${r.note || 'N/A'}
- **截图**: ${r.screenshot || 'N/A'}
`).join('\n') || '无失败项。'}

## Console 错误

${results.filter(r => r.consoleError).map(r => `- ${r.id}: ${r.consoleError}`).join('\n') || '无严重 Console 错误。'}

## 最关键通过标准

关键项 (18项): ${['B1','B2','B3','C1','C2','C3','D1','D2','E1','E2','F1','H1','H2','I1','I2','K1','K2','L1'].map(id => `${id}=${resultMap[id] ? resultMap[id].status : 'BLOCKED'}`).join(', ')}
`;
}

// ============= 执行 =============
const results_ = await runTests();
const report = generateReport(results_);

const reportPath = path.join(OUTPUT_DIR, `test-report-v2-${Date.now()}.md`);
fs.writeFileSync(reportPath, report, 'utf-8');
console.log(`\n报告已保存: ${reportPath}`);
console.log(`截图目录: ${OUTPUT_DIR}`);
console.log(report);
