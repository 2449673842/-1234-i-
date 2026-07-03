# SciFigure Studio 语义能力矩阵

本矩阵记录了 SciFigure Studio 对于各类科研绘图图元的内省识别、可视化编辑以及渲染一致性的支持级别。

## 1. 语义能力矩阵一览表

| 图元对象 | 源码实现 | 单元测试 | 浏览器验证 | 可编辑属性 | 导出一致性 | 测试 Fixture | 已知风险 / 注意事项 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **text** (普通文本) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `text`, `fontsize`, `fontfamily`, `color`, `ha`, `va`, `rotation`, `position`, `zorder` | 🟢 高一致性 | 🟢 有 | 数学公式 `$` 语法渲染暂不可进行纯文本修改，建议通过 `code_patch` 调整。 |
| **axis** (坐标轴系统) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `xlim`, `ylim`, `show_minor_ticks`, `x_tick_rotation`, `tick_direction`, `zorder` | 🟢 高一致性 | 🟢 有 | 部分复杂的 twinx / twiny 双轴共享需要特别注意坐标轴重叠。 |
| **tick** (刻度线/刻度标签) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `limits`, `label`, `label_fontsize`, `label_color`, `tick_rotation`, `tick_direction`, `tick_length`, `tick_width`, `tick_color`, `tick_pad`, `show_minor_ticks` | 🟢 高一致性 | 🟢 有 | 动态添加刻度位置在 matplotlib 脚本层 and 图元 patch 层可能有少量偏移。 |
| **spine** (外框线) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `visible`, `color`, `linewidth`, `zorder` | 🟢 高一致性 | 🟢 有 | 隐藏 top/right spine 后若进行局部修改，可能触发重新着色。 |
| **grid** (网格线) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `visible`, `color`, `linewidth`, `linestyle`, `alpha`, `zorder` | 🟢 高一致性 | 🟢 有 | 网格线密度与坐标轴 tick 数目自动关联，只读属性为全局设定。 |
| **legend** (图例) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `visible`, `fontsize`, `frameon`, `facecolor`, `edgecolor`, `linewidth`, `alpha`, `loc`, `ncol`, `markerscale`, `title`, `fontfamily`, `zorder` | 🟢 高一致性 | 🟢 有 | 修改图例的文本可能因字体加载导致图例框尺寸重算，建议启用 `tight_layout`。 |
| **line** (折线) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `linewidth`, `linestyle`, `alpha`, `marker`, `markersize`, `zorder` | 🟢 高一致性 | 🟢 有 | 单条线中的某个点不支持单独修改颜色（需通过 scatter 替代）。 |
| **scatter** (散点/集合) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `facecolor`, `edgecolor`, `alpha`, `linewidth`, `size`, `zorder` | 🟢 高一致性 | 🟢 有 | 当数据点数超大（>10,000）时，内省操作可能有几十毫秒延迟。 |
| **bar** (条形图) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `facecolor`, `edgecolor`, `alpha`, `linewidth`, `zorder` | 🟢 高一致性 | 🟢 有 | 堆叠柱状图 of rect patches 支持分组改色。 |
| **errorbar** (误差棒) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `linewidth`, `elinewidth`, `capsize`, `capthick`, `alpha`, `marker`, `markersize`, `zorder` | 🟢 高一致性 | 🟢 有 | 需要在脚本中通过 `ax.errorbar()` 正确产生 container，方可进行批量识别。 |
| **boxplot** (箱线图) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `linewidth`, `alpha`, `box_color`, `median_color`, `zorder` | 🟢 高一致性 | 🟢 有 | 箱线图内部元素（fliers, whiskers, caps）通过 container 聚合进行批量覆盖。 |
| **violinplot** (小提琴图) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `facecolor`, `edgecolor`, `linewidth`, `alpha`, `zorder` | 🟢 高一致性 | 🟢 有 | 小提琴图内部轮廓填充通过 `bodies` 分组进行批量控制。 |
| **heatmap** (热图) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `cmap`, `vmin`, `vmax`, `alpha` | 🟢 高一致性 | 🟢 有 | `imshow` / `pcolormesh` 底层对象目前已实现全自动只读识别和 patch 安全应用。 |
| **colorbar** (色条) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `label`, `tick_fontsize`, `left`, `bottom`, `width`, `height` | 🟢 高一致性 | 🟢 有 | 手动调整色条位置大小将自动解锁 matplotlib 约束并跳过 tight_layout。 |
| **annotation** (标注) | 🟡 部分 | 🔴 无 | 🔴 未接入 | `text`, `fontsize`, `fontfamily`, `color` | 🟢 高一致性 | 🔴 无 | 标注的箭头类型、指向位置因高度定制化，目前仅作为普通文本提取修改。 |
| **multi-panel** (多子图拼图) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `layout` (位置，子图宽高，间距，编号) | 🟢 高一致性 | 🟢 有 | 拼图项目在组合图高级工作台中进行统一的排版布局及撤销、重做历史回放。 |

## 2. 状态说明

* **🟢 已验证 / 通过 / 是**：具备完整的 Matplotlib 底层对象类型探测能力，支持属性双向提取，已通过自动化集成测试或 headless 浏览器级的实测验证。
* **🟡 未验证 / 部分**：源码已实现且测试用例覆盖，但尚未通过 headless 浏览器级的物理点击流程进行最终视觉审查，列为“Code Path 已验证，待物理验证”。
* **🔴 未接入 / 无**：尚未在该维度覆盖或支持。
