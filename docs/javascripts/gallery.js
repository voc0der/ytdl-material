// Opens a gallery screenshot full size in a dialog over the page, with the others in the same
// gallery a key or a button away. Without this script each thumbnail is still a link to the
// full-size image. It runs on every page load, including the theme's instant navigation.

document$.subscribe(() => {
  const galleries = [...document.querySelectorAll(".md-typeset .gallery")];
  if (galleries.length === 0) return;

  const viewer = galleryViewer();
  for (const gallery of galleries) {
    const links = [...gallery.querySelectorAll("figure > a")];
    links.forEach((link, index) => link.addEventListener("click", event => {
      // Leave a modified click to the browser, so the image can still open in a new tab.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      viewer.show(links, index);
    }));
  }
});

// One dialog, made the first time a gallery is on the page and kept for later pages.
function galleryViewer() {
  if (galleryViewer.instance) return galleryViewer.instance;

  const dialog = document.createElement("dialog");
  dialog.className = "gallery-viewer";
  dialog.innerHTML = `
    <figure>
      <img alt="">
      <figcaption><span class="gallery-viewer__caption"></span> <span class="gallery-viewer__count"></span></figcaption>
    </figure>
    <button type="button" class="gallery-viewer__button gallery-viewer__close" aria-label="Close">&times;</button>
    <button type="button" class="gallery-viewer__button gallery-viewer__previous" aria-label="Previous screenshot">&lsaquo;</button>
    <button type="button" class="gallery-viewer__button gallery-viewer__next" aria-label="Next screenshot">&rsaquo;</button>`;
  document.body.append(dialog);

  const image = dialog.querySelector("img");
  const caption = dialog.querySelector(".gallery-viewer__caption");
  const count = dialog.querySelector(".gallery-viewer__count");
  let links = [];
  let current = 0;

  function show(gallery_links, index) {
    links = gallery_links;
    current = (index + links.length) % links.length;
    const link = links[current];
    const thumbnail = link.querySelector("img");
    image.src = link.href;
    image.alt = thumbnail?.alt ?? "";
    dialog.dataset.shape = link.closest(".gallery")?.dataset.shape ?? "";
    caption.textContent = link.closest("figure")?.querySelector("figcaption")?.textContent.trim() ?? "";
    count.textContent = `${current + 1} of ${links.length}`;
    if (!dialog.open) dialog.showModal();
  }

  dialog.querySelector(".gallery-viewer__close").addEventListener("click", () => dialog.close());
  dialog.querySelector(".gallery-viewer__previous").addEventListener("click", () => show(links, current - 1));
  dialog.querySelector(".gallery-viewer__next").addEventListener("click", () => show(links, current + 1));

  // A click on the backdrop lands on the dialog itself; one on the image or a button does not.
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });

  // Escape and Tab keep their default actions. No key reaches the page behind, where the
  // theme turns some bare keys into navigation.
  dialog.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") show(links, current - 1);
    if (event.key === "ArrowRight") show(links, current + 1);
    event.stopPropagation();
  });

  galleryViewer.instance = { show };
  return galleryViewer.instance;
}
