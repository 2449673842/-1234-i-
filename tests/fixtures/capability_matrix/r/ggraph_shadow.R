library(ggplot2)

GeomNodePoint <- ggproto("GeomNodePoint", GeomPoint)
GeomEdgePath <- ggproto("GeomEdgePath", GeomPath)

geom_node_point_shadow <- function(data, mapping) {
  layer(
    data = data,
    mapping = mapping,
    stat = "identity",
    geom = GeomNodePoint,
    position = "identity",
    inherit.aes = FALSE,
    params = list(na.rm = FALSE, size = 4)
  )
}

geom_edge_path_shadow <- function(data, mapping) {
  layer(
    data = data,
    mapping = mapping,
    stat = "identity",
    geom = GeomEdgePath,
    position = "identity",
    inherit.aes = FALSE,
    params = list(na.rm = FALSE, linewidth = 1)
  )
}

nodes <- data.frame(id = c("n1", "n2"), x = c(1, 2), y = c(1, 2))
edge <- data.frame(x = c(1, 2), y = c(1, 2), edge_id = c("e1", "e1"))

p <- ggplot() +
  geom_edge_path_shadow(edge, aes(x, y, group = edge_id)) +
  geom_node_point_shadow(nodes, aes(x, y)) +
  coord_cartesian(xlim = c(0.5, 2.5), ylim = c(0.5, 2.5)) +
  theme_void()

p
