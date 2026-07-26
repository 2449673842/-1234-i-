library(ggplot2)
library(grid)

scifigure_semantic_gid <- function(diagram_id, role, object_id, diagram_type = "sem",
                                   node_id = NULL, edge_id = NULL,
                                   source_node_id = NULL, target_node_id = NULL) {
  fields <- c(
    diagram = diagram_id,
    type = diagram_type,
    role = role,
    id = object_id
  )
  if (!is.null(node_id)) fields <- c(fields, node = node_id)
  if (!is.null(edge_id)) fields <- c(fields, edge = edge_id)
  if (!is.null(source_node_id)) fields <- c(fields, source = source_node_id)
  if (!is.null(target_node_id)) fields <- c(fields, target = target_node_id)
  encoded <- vapply(names(fields), function(name) {
    paste0(utils::URLencode(name, reserved = TRUE), "=", utils::URLencode(fields[[name]], reserved = TRUE))
  }, character(1))
  paste0("scifigure-sem-v1:", paste(encoded, collapse = "&"))
}

diagram_id <- "sem.demo"
edge_id <- "latent_a_to_observed_b"
path_edge_id <- "latent_a_path_to_observed_b"

group_df <- data.frame(
  xmin = 0.08, xmax = 0.92, ymin = 0.39, ymax = 0.85,
  .scifigure_id = "measurement_model",
  .scifigure_semantic_gid = scifigure_semantic_gid(
    diagram_id, "group", "measurement_model", diagram_type = "sem"
  )
)

node_df <- data.frame(
  node_id = c("latent_a", "observed_b"),
  x = c(0.25, 0.75),
  y = c(0.62, 0.62),
  node_shape = c("latent", "observed"),
  fill = c("#4477AA", "#CC6677"),
  .scifigure_id = c("latent_a", "observed_b"),
  .scifigure_semantic_gid = c(
    scifigure_semantic_gid(diagram_id, "node", "latent_a", diagram_type = "sem"),
    scifigure_semantic_gid(diagram_id, "node", "observed_b", diagram_type = "sem")
  )
)

edge_df <- data.frame(
  edge_id = edge_id,
  x = 0.37, y = 0.62, xend = 0.63, yend = 0.62,
  .scifigure_id = edge_id,
  .scifigure_semantic_gid = scifigure_semantic_gid(
    diagram_id, "edge", edge_id, diagram_type = "sem",
    source_node_id = "latent_a", target_node_id = "observed_b"
  )
)

arrow_df <- data.frame(
  arrow_id = "arrow_a_b",
  x = 0.57, y = 0.62, xend = 0.64, yend = 0.62,
  .scifigure_id = "arrow_a_b",
  .scifigure_semantic_gid = scifigure_semantic_gid(
    diagram_id, "arrow", "arrow_a_b", diagram_type = "sem",
    edge_id = edge_id, source_node_id = "latent_a", target_node_id = "observed_b"
  )
)

path_df <- data.frame(
  edge_id = path_edge_id,
  x = c(0.37, 0.50, 0.63),
  y = c(0.56, 0.49, 0.56),
  vertex_order = c(1, 2, 3),
  .scifigure_id = path_edge_id,
  .scifigure_semantic_gid = scifigure_semantic_gid(
    diagram_id, "edge", path_edge_id, diagram_type = "sem",
    source_node_id = "latent_a", target_node_id = "observed_b"
  )
)

label_df <- data.frame(
  label_id = c("label_latent_a", "label_observed_b", "coef_a_b"),
  label = c("Latent A", "Observed B", "beta = 0.42, p = 0.003"),
  x = c(0.25, 0.75, 0.50),
  y = c(0.62, 0.62, 0.69),
  role = c("node_label", "node_label", "coefficient_label"),
  node_id = c("latent_a", "observed_b", NA),
  edge_id = c(NA, NA, edge_id),
  .scifigure_id = c("label_latent_a", "label_observed_b", "coef_a_b"),
  .scifigure_semantic_gid = c(
    scifigure_semantic_gid(
      diagram_id, "node_label", "label_latent_a", diagram_type = "sem",
      node_id = "latent_a"
    ),
    scifigure_semantic_gid(
      diagram_id, "node_label", "label_observed_b", diagram_type = "sem",
      node_id = "observed_b"
    ),
    scifigure_semantic_gid(
      diagram_id, "coefficient_label", "coef_a_b", diagram_type = "sem",
      edge_id = edge_id
    )
  )
)

fit_df <- data.frame(
  label_id = "fit_summary",
  label = "CFI = 0.96; RMSEA = 0.04",
  x = 0.04, y = 0.08,
  .scifigure_id = "fit_summary",
  .scifigure_semantic_gid = scifigure_semantic_gid(
    diagram_id, "fit_annotation", "fit_summary", diagram_type = "sem"
  )
)

ordinary_nodes <- data.frame(x = c(1.25, 1.75), y = c(0.70, 0.70))
ordinary_edges <- data.frame(x = 1.25, y = 0.35, xend = 1.75, yend = 0.70)
ordinary_arrow <- data.frame(x = 1.30, y = 0.20, xend = 1.70, yend = 0.20)
ordinary_text <- data.frame(x = 1.50, y = 0.86, label = "ordinary text")

p <- ggplot() +
  geom_rect(
    data = group_df,
    aes(xmin = xmin, xmax = xmax, ymin = ymin, ymax = ymax),
    inherit.aes = FALSE,
    fill = NA,
    colour = "#999999",
    linewidth = 0.35,
    linetype = "dashed"
  ) +
  geom_segment(
    data = edge_df,
    aes(x = x, y = y, xend = xend, yend = yend),
    inherit.aes = FALSE,
    colour = "#333333",
    linewidth = 0.8
  ) +
  geom_segment(
    data = arrow_df,
    aes(x = x, y = y, xend = xend, yend = yend),
    inherit.aes = FALSE,
    colour = "#333333",
    linewidth = 0.7,
    arrow = arrow(length = unit(3, "mm"), type = "closed")
  ) +
  geom_path(
    data = path_df,
    aes(x = x, y = y, group = edge_id),
    inherit.aes = FALSE,
    colour = "#8844AA",
    linewidth = 0.55,
    linetype = "dotted"
  ) +
  geom_point(
    data = node_df,
    aes(x = x, y = y, shape = node_shape, fill = node_shape),
    inherit.aes = FALSE,
    size = 10,
    stroke = 0.7,
    colour = "#223355"
  ) +
  geom_text(
    data = label_df,
    aes(x = x, y = y, label = label),
    inherit.aes = FALSE,
    size = 3.1,
    colour = "#111111"
  ) +
  geom_text(
    data = fit_df,
    aes(x = x, y = y, label = label),
    inherit.aes = FALSE,
    hjust = 0,
    size = 2.8,
    colour = "#111111"
  ) +
  geom_point(
    data = ordinary_nodes,
    aes(x = x, y = y),
    inherit.aes = FALSE,
    size = 5,
    shape = 22,
    fill = "#44AA99",
    colour = "#226655"
  ) +
  geom_segment(
    data = ordinary_edges,
    aes(x = x, y = y, xend = xend, yend = yend),
    inherit.aes = FALSE,
    colour = "#777777",
    linewidth = 0.7
  ) +
  geom_segment(
    data = ordinary_arrow,
    aes(x = x, y = y, xend = xend, yend = yend),
    inherit.aes = FALSE,
    colour = "#777777",
    linewidth = 0.7,
    arrow = arrow(length = unit(2.4, "mm"), type = "open")
  ) +
  geom_text(
    data = ordinary_text,
    aes(x = x, y = y, label = label),
    inherit.aes = FALSE,
    size = 3,
    colour = "#555555"
  ) +
  scale_shape_manual(values = c(latent = 21, observed = 22)) +
  scale_fill_manual(values = c(latent = "#4477AA", observed = "#CC6677")) +
  coord_cartesian(xlim = c(0, 2), ylim = c(0, 1), expand = FALSE, clip = "off") +
  labs(title = "R explicit SEM semantics", x = NULL, y = NULL) +
  theme_void(base_size = 10) +
  theme(legend.position = "none", plot.margin = margin(8, 8, 8, 8))

p
