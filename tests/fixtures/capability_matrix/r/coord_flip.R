library(ggplot2)

df <- data.frame(category = c("A", "B", "C"), value = c(2.1, 3.5, 2.8))
p <- ggplot(df, aes(category, value)) +
  geom_col(fill = "#2C7FB8") +
  geom_text(aes(label = value), vjust = -0.4) +
  coord_flip() +
  theme_classic()
p
