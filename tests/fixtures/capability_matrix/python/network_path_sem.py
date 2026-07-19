import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, Rectangle


fig, (sem_ax, ordinary_ax) = plt.subplots(1, 2, figsize=(8.0, 3.6))

diagram_id = "sem.demo"
latent = Circle(
    (0.25, 0.62),
    0.12,
    facecolor="#4477aa",
    edgecolor="#223355",
    linewidth=1.4,
    gid=_scifigure_semantic_gid(diagram_id, "node", "latent_a", diagram_type="sem"),
)
sem_ax.add_patch(latent)

observed = sem_ax.scatter(
    [0.75],
    [0.62],
    s=[620],
    marker="s",
    c=["#cc6677"],
    edgecolors=["#663344"],
    linewidths=1.2,
    gid=_scifigure_semantic_gid(diagram_id, "node", "observed_b", diagram_type="sem"),
)

edge_id = "latent_a_to_observed_b"
sem_ax.plot(
    [0.37, 0.63],
    [0.62, 0.62],
    color="#333333",
    linewidth=1.8,
    gid=_scifigure_semantic_gid(
        diagram_id,
        "edge",
        edge_id,
        diagram_type="sem",
        source_node_id="latent_a",
        target_node_id="observed_b",
    ),
)

arrow = FancyArrowPatch(
    (0.57, 0.62),
    (0.64, 0.62),
    arrowstyle="-|>",
    mutation_scale=14,
    facecolor="#333333",
    edgecolor="#333333",
    linewidth=1.2,
    gid=_scifigure_semantic_gid(
        diagram_id,
        "arrow",
        "arrow_a_b",
        diagram_type="sem",
        edge_id=edge_id,
        source_node_id="latent_a",
        target_node_id="observed_b",
    ),
)
sem_ax.add_patch(arrow)

group = Rectangle(
    (0.08, 0.39),
    0.84,
    0.46,
    fill=False,
    edgecolor="#999999",
    linewidth=0.9,
    linestyle="--",
    gid=_scifigure_semantic_gid(
        diagram_id,
        "group",
        "measurement_model",
        diagram_type="sem",
    ),
)
sem_ax.add_patch(group)

sem_ax.text(
    0.25,
    0.62,
    "Latent A",
    ha="center",
    va="center",
    gid=_scifigure_semantic_gid(
        diagram_id,
        "node_label",
        "label_latent_a",
        diagram_type="sem",
        node_id="latent_a",
    ),
)
sem_ax.text(
    0.75,
    0.62,
    "Observed B",
    ha="center",
    va="center",
    gid=_scifigure_semantic_gid(
        diagram_id,
        "node_label",
        "label_observed_b",
        diagram_type="sem",
        node_id="observed_b",
    ),
)
sem_ax.text(
    0.50,
    0.68,
    "beta = 0.42***",
    ha="center",
    va="bottom",
    color="#111111",
    gid=_scifigure_semantic_gid(
        diagram_id,
        "coefficient_label",
        "coef_a_b",
        diagram_type="sem",
        edge_id=edge_id,
    ),
)
sem_ax.text(
    0.04,
    0.08,
    "CFI = 0.96; RMSEA = 0.04",
    transform=sem_ax.transAxes,
    gid=_scifigure_semantic_gid(
        diagram_id,
        "fit_annotation",
        "fit_summary",
        diagram_type="sem",
    ),
)
sem_ax.set(xlim=(0, 1), ylim=(0, 1), title="Explicit SEM semantics")
sem_ax.axis("off")

# Negative controls: identical primitive classes without explicit semantics.
ordinary_ax.scatter([0.2], [0.7], s=[180], c=["#44aa99"], label="ordinary scatter")
ordinary_ax.plot([0.2, 0.8], [0.3, 0.7], color="#777777", label="ordinary line")
ordinary_arrow = FancyArrowPatch(
    (0.3, 0.2),
    (0.7, 0.2),
    arrowstyle="->",
    color="#777777",
    label="ordinary arrow",
)
ordinary_ax.add_patch(ordinary_arrow)
ordinary_ax.text(0.5, 0.85, "ordinary text", ha="center")
ordinary_ax.set(xlim=(0, 1), ylim=(0, 1), title="Generic controls")

fig.tight_layout()
