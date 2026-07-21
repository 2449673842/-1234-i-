library(ggplot2)

df <- expand.grid(
  row_group = c("North", "South"),
  col_group = c("Early", "Late"),
  replicate = 1:3
)
df$x <- df$replicate
df$y <- seq_len(nrow(df)) / 2
p <- ggplot(df, aes(x, y)) +
  geom_point(size = 2.2, color = "#2C7FB8") +
  facet_grid(row_group ~ col_group) +
  theme_classic()
p
