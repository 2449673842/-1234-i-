library(ggplot2)

GeomTextRepel <- ggproto("GeomTextRepel", GeomText)
GeomLabelRepel <- ggproto("GeomLabelRepel", GeomLabel)

geom_text_repel_shadow <- function(data, mapping) {
  layer(
    data = data,
    mapping = mapping,
    stat = "identity",
    geom = GeomTextRepel,
    position = "identity",
    inherit.aes = FALSE,
    params = list(na.rm = FALSE)
  )
}

geom_label_repel_shadow <- function(data, mapping) {
  layer(
    data = data,
    mapping = mapping,
    stat = "identity",
    geom = GeomLabelRepel,
    position = "identity",
    inherit.aes = FALSE,
    params = list(na.rm = FALSE)
  )
}

labels <- data.frame(
  id = c("alpha", "beta"),
  x = c(1, 2),
  y = c(1.1, 1.9),
  label = c("Alpha", "Beta")
)

p <- ggplot() +
  geom_text_repel_shadow(labels[1, , drop = FALSE], aes(x, y, label = label)) +
  geom_label_repel_shadow(labels[2, , drop = FALSE], aes(x, y, label = label)) +
  coord_cartesian(xlim = c(0.5, 2.5), ylim = c(0.5, 2.5)) +
  theme_classic()

p
