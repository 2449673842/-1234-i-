# Workspace Rules & Guidelines

## Matplotlib Constraints
1. **Shared Axes tick labels (`sharex=True` / `sharey=True`)**:
   - In Matplotlib subplots with shared coordinates, clearing ticks on one axis using `ax.set_xticklabels([])` or `ax.set_yticklabels([])` will affect and clear all shared subplots.
   - Always set the full tick labels once: `ax.set_xticklabels(labels)`.
   - Control tick label visibility per subplot using:
     ```python
     ax.tick_params(axis="x", labelbottom=show_xlabel)
     ax.tick_params(axis="y", labelleft=show_ylabel)
     ```
