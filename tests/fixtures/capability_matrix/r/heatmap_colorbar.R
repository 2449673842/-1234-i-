library(ggplot2)

df <- expand.grid(x = 1:4, y = 1:3)
df$value <- seq_len(nrow(df)) / 10
p <- ggplot(df, aes(x, y, fill = value)) +
  geom_tile() +
  scale_fill_gradient(low = "#132B43", high = "#56B1F7", name = "Intensity") +
  theme_classic()
p
