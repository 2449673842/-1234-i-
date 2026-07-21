library(ggplot2)

df <- expand.grid(x = 1:5, y = 1:4)
df$value <- seq_len(nrow(df)) / 5
p <- ggplot(df, aes(x, y, fill = value)) +
  geom_raster() +
  scale_fill_gradient(low = "#132B43", high = "#56B1F7", name = "Signal") +
  theme_classic()
p
