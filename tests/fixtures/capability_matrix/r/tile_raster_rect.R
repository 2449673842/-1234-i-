library(ggplot2)

df <- expand.grid(x = 1:4, y = 1:3)
df$value <- seq_len(nrow(df)) / 10

p <- ggplot(df, aes(x = x, y = y, fill = value)) +
  geom_tile(colour = "#333333", linewidth = 0.35, alpha = 0.85) +
  geom_raster(alpha = 0.55) +
  geom_rect(
    aes(xmin = x - 0.45, xmax = x + 0.45, ymin = y - 0.45, ymax = y + 0.45),
    inherit.aes = TRUE,
    colour = "#111111",
    linewidth = 0.25,
    alpha = 0.35
  ) +
  scale_fill_gradient(low = "#132B43", high = "#56B1F7", limits = c(0, 2), name = "Intensity") +
  theme_classic()

p
