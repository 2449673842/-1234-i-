library(ggplot2)

df <- data.frame(
  id = c("site-a", "site-b"),
  x = c(1, 2),
  y = c(1.2, 2.1),
  label = c("Site A", "Site B")
)

p <- ggplot(df, aes(x, y)) +
  geom_point(size = 3, colour = "#1F78B4") +
  geom_text(aes(label = label), nudge_y = 0.12) +
  theme_classic()

coord_sf_shadow <- coord_cartesian()
class(coord_sf_shadow) <- c("CoordSf", class(coord_sf_shadow))
p$coordinates <- coord_sf_shadow
p
