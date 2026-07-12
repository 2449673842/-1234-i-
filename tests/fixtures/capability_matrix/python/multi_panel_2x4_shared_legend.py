import matplotlib.pyplot as plt

fig, axes = plt.subplots(2, 4, figsize=(10, 5))
handles = []
labels = []
for index, ax in enumerate(axes.flat):
    line, = ax.plot([0, 1, 2], [index, index + 1, index + 0.25], label=f"Panel {index + 1}")
    ax.set_title(f"P{index + 1}")
    handles.append(line)
    labels.append(f"P{index + 1}")

fig.legend(handles[:2], labels[:2], loc="lower center", ncol=2, title="Shared legend")
fig.subplots_adjust(bottom=0.18)
