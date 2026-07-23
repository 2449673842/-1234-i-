library(ggplot2)

df <- expand.grid(x = seq(-2, 2, length.out = 15), y = seq(-2, 2, length.out = 15))
df$z <- with(df, x^2 + y^2)

p <- ggplot(df, aes(x = x, y = y, z = z)) +
  geom_contour(aes(colour = after_stat(level)), bins = 5, linewidth = 0.65) +
  geom_contour_filled(bins = 5, alpha = 0.7) +
  scale_colour_viridis_c(name = "Contour level") +
  scale_fill_viridis_d(name = "Contour bands") +
  theme_classic()

p
