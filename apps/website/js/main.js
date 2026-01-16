// Bondfires Website - Main JavaScript

// Mobile Navigation Toggle
(function() {
  const menuToggle = document.querySelector('.mobile-menu-toggle');
  const navLinks = document.querySelector('.nav-links');

  if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', function() {
      navLinks.classList.toggle('open');
      const isOpen = navLinks.classList.contains('open');
      
      // Update aria-expanded for accessibility
      menuToggle.setAttribute('aria-expanded', isOpen);
      
      // Close menu when clicking outside
      if (isOpen) {
        document.addEventListener('click', function closeMenu(e) {
          if (!navLinks.contains(e.target) && e.target !== menuToggle) {
            navLinks.classList.remove('open');
            menuToggle.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', closeMenu);
          }
        });
      }
    });

    // Close menu when clicking a nav link (on mobile)
    const links = navLinks.querySelectorAll('a');
    links.forEach(link => {
      link.addEventListener('click', function() {
        if (window.innerWidth <= 767) {
          navLinks.classList.remove('open');
          menuToggle.setAttribute('aria-expanded', 'false');
        }
      });
    });
  }
})();

// Smooth scroll for anchor links
(function() {
  const anchorLinks = document.querySelectorAll('a[href^="#"]');
  
  anchorLinks.forEach(link => {
    link.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      
      // Skip if it's just "#"
      if (href === '#' || href === '#!') {
        return;
      }
      
      const target = document.querySelector(href);
      
      if (target) {
        e.preventDefault();
        const offsetTop = target.offsetTop - 80; // Account for sticky nav
        
        window.scrollTo({
          top: offsetTop,
          behavior: 'smooth'
        });
      }
    });
  });
})();

// App Store Link Detection (for analytics or customization)
(function() {
  const appStoreLinks = document.querySelectorAll('[data-app-store]');
  
  appStoreLinks.forEach(link => {
    link.addEventListener('click', function() {
      const platform = this.getAttribute('data-app-store');
      // You can add analytics tracking here
      console.log('App store link clicked:', platform);
    });
  });
})();
